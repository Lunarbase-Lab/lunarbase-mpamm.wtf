import { BaseSource } from './index.js';
import {
  MARKETS, SIZES_USD, MARKOUT_HORIZONS, ADDR,
  type DataSourceMode, type MarketState, type QuoteSnapshot, type QuoteRow, type Fill, type DailyVolume,
} from '@shared';
import { config } from '../config.js';
import { publicClient, getLogsChunked, probeChain } from '../chain/rpc.js';
import { lbPairAbi, bookManagerAbi, routerGatewayAbi, liquidityVaultAbi } from '../chain/abis.js';
import { BybitFeed } from '../bybit.js';
import { UsdPricer } from '../pricer.js';
import { discoverLfj, quoteLfj, decodeLfjSwap, type LbMarket } from '../venues/lfj.js';
import {
  discoverClober, discoverCloberViaSubgraph, quoteClober, decodeCloberTake,
  buildRouterMap, cloberBookFromOpen, assembleCloberMarkets,
  type CloberBook, type CloberMarket,
} from '../venues/clober.js';
import { VolumeStore } from '../db.js';
import { seedCloberDaily } from '../seed/subgraph.js';
import { utcDay, annotateCex } from '../util.js';

/**
 * LiveDataSource — real Monad RPC + Bybit, run as a persist-forward indexer.
 *
 *  - quotes: Multicall3 eth_call (LFJ getSwapOut + Clober getExpectedOutput) and
 *    Bybit book-walk, at block cadence.
 *  - fills:  getLogs tail (LFJ Swap, Clober Take), priced via the stable quote
 *    leg, bucketed into UTC-day volume; each fill joined to the Bybit mid for
 *    0/5/10/30/60s markouts.
 *  - history: the SQLite DB is authoritative. On boot we load persisted days +
 *    lastProcessedBlock, refresh closed Clober days from the subgraph (the only
 *    cheap source of deep history), and either gap-fill from the last processed
 *    block (same-day restart) or start forward from the tip. LFJ history has no
 *    keyless source, so it accumulates forward from first run.
 */
export class LiveDataSource extends BaseSource {
  readonly mode: DataSourceMode = 'live';

  private bybit = new BybitFeed();
  private pricer = new UsdPricer(() => this.bybit.monUsd());
  private store = new VolumeStore(config.dbPath);
  private lfj: LbMarket[] = [];
  private lfjByAddr = new Map<string, LbMarket>();
  private clober: { markets: CloberMarket[]; books: Map<string, CloberBook>; vault: Set<string> } = { markets: [], books: new Map(), vault: new Set() };

  private quotes: QuoteSnapshot = { block: 0, monUsd: 0, ts: 0, rows: [] };
  private days: DailyVolume[] = [];
  private fills: Fill[] = [];
  private pending = new Set<Fill>();
  private dirty = new Set<Fill>();
  /** ids already counted into the volume buckets (kept in sync with the fills
   *  window) — makes ingest idempotent so a re-decode never double-counts. */
  private countedIds = new Set<string>();
  private midHist: { t: number; mid: number }[] = [];
  private lastBlock = 0n;
  private timer?: ReturnType<typeof setInterval>;
  private persistTimer?: ReturnType<typeof setInterval>;
  private notes: string[] = [];
  private block = 0;

  async start(): Promise<void> {
    // Fail fast on an unreachable/wrong chain (spec §8) rather than half-start.
    const probe = await probeChain();
    if (!probe.ok) throw new Error(`Monad RPC sanity check failed (${probe.reason}). Set DATA_SOURCE=sim to run offline.`);

    await this.bybit.start();
    try { this.lfj = await discoverLfj(); } catch (e) { this.notes.push('LFJ discovery failed: ' + (e as Error).message); }
    this.lfjByAddr = new Map(this.lfj.map((m) => [m.pair.toLowerCase(), m]));

    // Clober book cache (subgraph) — before history so the volume seed can be
    // scoped to these MON/stable books (the public RPC can't enumerate them).
    // Live quotes/fills still hit the chain. Falls back to a recent-Open scan.
    try {
      this.clober = await discoverCloberViaSubgraph(config.subgraphUrl);
      this.notes.push(`Clober: ${this.clober.markets.length} market(s) from subgraph (${this.clober.books.size} books, ${this.clober.vault.size} vault)`);
    } catch {
      this.notes.push('Clober subgraph discovery failed; trying recent Open logs');
      try { this.clober = await discoverClober(2000); } catch { /* leave empty */ }
    }

    await this.initHistory();

    await this.poll().catch(() => undefined);
    this.timer = setInterval(() => { void this.tick(); }, config.quoteIntervalMs);
    this.persistTimer = setInterval(() => this.persist(), config.persistMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.persist();
    this.bybit.stop();
    this.store.close();
  }

  getState(): MarketState {
    return {
      chainId: 143, block: this.block, monUsd: this.bybit.monUsd(), monChangePct: this.bybit.changePct(),
      takerBps: config.takerBps, markets: [...MARKETS], sizesUsd: [...SIZES_USD],
      quoteCadenceMs: config.quoteIntervalMs, source: 'live', notes: this.notes,
    };
  }
  getQuotes(): QuoteSnapshot { return this.quotes; }
  getFills(): Fill[] { return this.fills; }
  getVolume(): DailyVolume[] { return this.days.map((d) => ({ ...d })); }

  // ── history: load + seed + resume (persist-forward indexer) ─────────────────
  private async initHistory(): Promise<void> {
    // 1. authoritative persisted history
    this.days = this.store.all();
    // load recent fills for live serving; drop rows past the retention window
    this.store.pruneFills(Date.now() - config.fillsRetentionDays * 86_400_000);
    this.fills = this.store.recentFills(400);
    // seed the dedup guard with the persisted window: these fills are already
    // reflected in the persisted volume, so a gap-fill that re-decodes them
    // (e.g. after a crash before the cursor advanced) won't re-count them.
    for (const f of this.fills) this.countedIds.add(f.id);

    // 2. refresh closed Clober days from the subgraph (cheap deep-history seed)
    const today = utcDay();
    try {
      // scope the volume seed to the discovered MON/stable books (spec D5)
      const venueBookIds = [...this.clober.books.values()].map((b) => String(b.bookId));
      const vaultBookIds = [...this.clober.vault];
      const seed = await seedCloberDaily(config.subgraphUrl, config.seedSinceUtc, venueBookIds, vaultBookIds);
      let seeded = 0;
      for (const [day, cd] of seed) {
        if (day >= today) continue; // today is owned by live tailing
        let row = this.days.find((d) => d.utcDay === day);
        if (!row) { row = this.emptyDay(day, false); this.days.push(row); }
        row.cloberVenue = cd.venue;
        row.cloberVault = cd.vault;
        row.partial = false;
        seeded++;
      }
      this.notes.push(`seeded ${seeded} closed Clober day(s) from subgraph; LFJ history accumulates forward`);
    } catch (e) {
      this.notes.push('Clober history seed unavailable (' + (e as Error).message + '); history grows forward');
    }
    this.days.sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
    this.today(); // ensure today's partial bucket, rolling any stale "today" closed
    this.reconcileSwapCounts(); // derive per-source swap counts from retained fills
    this.store.upsertMany(this.days);

    // 3. resume point — same-day gap-fill, else start at tip
    const head = await publicClient.getBlockNumber();
    this.block = Number(head);
    const lpb = this.store.getMeta('lastProcessedBlock');
    const lpd = this.store.getMeta('lastProcessedDay');
    if (lpb && lpd === today && head - BigInt(lpb) <= BigInt(config.gapFillMaxBlocks)) {
      this.lastBlock = BigInt(lpb);
      this.notes.push(`resuming: gap-filling ${head - BigInt(lpb)} block(s) since last run`);
    } else {
      this.lastBlock = head;
      this.notes.push(lpb ? 'restart across day boundary — today builds forward' : 'cold start — today builds forward from now');
    }
  }

  private persist(): void {
    try {
      // one transaction: volume + cursor + fills together, so a crash can never
      // leave the volume ahead of the cursor and let a gap-fill re-count (H1).
      this.store.persistSnapshot(
        this.days,
        { lastProcessedBlock: String(this.lastBlock), lastProcessedDay: utcDay() },
        this.dirty.size ? [...this.dirty] : [],
      );
      this.dirty.clear();
    } catch { /* non-fatal — dirty retained, retried next tick */ }
  }

  /** A fresh zeroed daily bucket. */
  private emptyDay(day: string, partial: boolean): DailyVolume {
    return { utcDay: day, lfj: 0, cloberVenue: 0, cloberVault: 0, swaps: 0, lfjSwaps: 0, cloberSwaps: 0, cloberVaultSwaps: 0, partial };
  }

  /**
   * Derive per-source swap counts (lfj / clober / vault) from the retained fills
   * — the authoritative per-fill record — so the protocol breakdown is accurate
   * across the retention window immediately (the schema migration adds those
   * columns zeroed). Days with no retained fills (older than retention, or the
   * subgraph-seeded Clober history) keep 0: we have their volume, not their
   * per-source swap count. Runs once at boot, before forward tailing.
   */
  private reconcileSwapCounts(): void {
    const bySrc = new Map<string, { lfj: number; clob: number; vault: number }>();
    for (const f of this.store.fillsSince(0, 50_000)) {
      const day = utcDay(f.ts);
      const e = bySrc.get(day) ?? { lfj: 0, clob: 0, vault: 0 };
      if (f.protocol === 'LFJ') e.lfj++;
      else { e.clob++; if (f.scope === 'vault') e.vault++; }
      bySrc.set(day, e);
    }
    for (const d of this.days) {
      const c = bySrc.get(d.utcDay);
      if (c) { d.lfjSwaps = c.lfj; d.cloberSwaps = c.clob; d.cloberVaultSwaps = c.vault; }
    }
  }

  /** Historical fills from the DB (the leaderboard/markouts query real windows). */
  queryFills(opts: { sinceMs?: number; limit?: number }): Fill[] {
    return this.store.fillsSince(opts.sinceMs ?? 0, Math.min(opts.limit ?? 1000, 50_000));
  }

  // ── poll loop ───────────────────────────────────────────────────────────────
  private async tick(): Promise<void> {
    try { await this.poll(); } catch { /* keep ticking */ }
    try { await this.tailFills(); } catch { /* tolerate */ }
    this.ageMarkouts();
    this.emitMsg({ ch: 'volume', data: { ...this.today() } });
  }

  private async poll(): Promise<void> {
    const monUsd = this.bybit.monUsd();
    if (monUsd <= 0) return;
    this.midHist.push({ t: Date.now(), mid: this.bybit.mid() });
    if (this.midHist.length > 400) this.midHist.shift();

    const head = await publicClient.getBlockNumber();
    this.block = Number(head);

    const [lfjRows, cloberRows] = await Promise.all([
      quoteLfj(this.lfj, config.sizesUsd, monUsd, this.pricer).catch(() => [] as QuoteRow[]),
      quoteClober(this.clober.markets, config.sizesUsd, monUsd, this.pricer).catch(() => [] as QuoteRow[]),
    ]);
    const bybitRows = this.bybitRows(monUsd);
    annotateCex([...lfjRows, ...cloberRows], bybitRows); // spec §4.2 (audit I1)
    this.quotes = { block: this.block, monUsd, ts: Date.now(), rows: [...lfjRows, ...cloberRows, ...bybitRows] };
    this.emitMsg({ ch: 'state', data: this.getState() });
    this.emitMsg({ ch: 'quotes', data: this.quotes });
  }

  /** Bybit-as-taker bid/ask per market×size (the benchmark venue). */
  private bybitRows(monUsd: number): QuoteRow[] {
    const fee = config.takerBps / 1e4;
    const rows: QuoteRow[] = [];
    const ts = Date.now();
    for (const market of MARKETS) {
      for (const size of SIZES_USD) {
        const base = size / monUsd;
        const buy = this.bybit.walk('buy', base);
        const sell = this.bybit.walk('sell', base);
        const askPx = buy.price * (1 + fee);
        const bidPx = sell.price * (1 - fee);
        rows.push({
          venue: 'Bybit', market, sizeUsd: size,
          askPx, bidPx, askBps: (askPx / monUsd - 1) * 1e4, bidBps: (bidPx / monUsd - 1) * 1e4,
          spreadBps: ((askPx - bidPx) / monUsd) * 1e4,
          filledFull: buy.filledFull && sell.filledFull, feeBps: config.takerBps, ts,
        });
      }
    }
    return rows;
  }

  // ── fills ───────────────────────────────────────────────────────────────────
  private async tailFills(): Promise<void> {
    const monUsd = this.bybit.monUsd();
    // Defer the tail until the Bybit mid is warm so markout anchors are sound;
    // lastBlock is not advanced, so the range is re-decoded once warm (audit C3).
    if (monUsd <= 0) return;
    const head = await publicClient.getBlockNumber();
    if (head <= this.lastBlock) return;
    const from = this.lastBlock + 1n;

    const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);
    const [lfjLogs, takeLogs, routerLogs, bmOpens, vaultOpens] = (await Promise.all([
      this.lfj.length
        ? getLogsChunked({ address: this.lfj.map((m) => m.pair) as `0x${string}`[], fromBlock: from, toBlock: head, events: [ev(lbPairAbi, 'Swap')] })
        : Promise.resolve([] as unknown[]),
      getLogsChunked({ address: ADDR.bookManager as `0x${string}`, fromBlock: from, toBlock: head, events: [ev(bookManagerAbi, 'Take')] }),
      getLogsChunked({ address: ADDR.routerGateway as `0x${string}`, fromBlock: from, toBlock: head, events: [ev(routerGatewayAbi, 'Swap')] }).catch(() => [] as unknown[]),
      getLogsChunked({ address: ADDR.bookManager as `0x${string}`, fromBlock: from, toBlock: head, events: [ev(bookManagerAbi, 'Open')] }).catch(() => [] as unknown[]),
      getLogsChunked({ address: ADDR.liquidityVault as `0x${string}`, fromBlock: from, toBlock: head, events: [ev(liquidityVaultAbi, 'Open')] }).catch(() => [] as unknown[]),
    ])) as [any[], any[], any[], any[], any[]];

    // C4: fold any newly-Opened MON/stable books into the cache before decoding.
    this.mergeNewBooks(bmOpens, vaultOpens);
    // I3: routed-flow attribution by txHash (used to classify Takes, not dup them).
    const routerMap = buildRouterMap(routerLogs);
    // B2: resolve block timestamps for the blocks that actually carry fills.
    const blocks = new Set<bigint>();
    for (const l of lfjLogs) blocks.add(l.blockNumber);
    for (const l of takeLogs) blocks.add(l.blockNumber);
    const blockTs = await this.blockTimes(blocks);
    const tsOf = (bn: bigint) => blockTs.get(String(bn)) ?? Date.now();

    const fresh: Fill[] = [];
    for (const l of lfjLogs) {
      const m = this.lfjByAddr.get(String(l.address).toLowerCase());
      if (!m) continue;
      const f = decodeLfjSwap(l, m, tsOf(l.blockNumber));
      if (f) fresh.push(f);
    }
    for (const l of takeLogs) {
      const f = decodeCloberTake(l, this.clober.books, this.clober.vault, tsOf(l.blockNumber), routerMap.get(String(l.transactionHash).toLowerCase()));
      if (f) fresh.push(f);
    }

    this.lastBlock = head;
    fresh.sort((a, b) => a.blockNumber - b.blockNumber);
    for (const f of fresh) this.ingest(f);
  }

  /** Block timestamps (ms) for the blocks that carry fills (audit B2). */
  private async blockTimes(blocks: Set<bigint>): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    await Promise.all([...blocks].map(async (bn) => {
      try { const b = await publicClient.getBlock({ blockNumber: bn }); m.set(String(bn), Number(b.timestamp) * 1000); } catch { /* fall back to now */ }
    }));
    return m;
  }

  /** Fold mid-run BookManager/LiquidityVault Opens into the cache (audit C4). */
  private mergeNewBooks(bmOpens: any[], vaultOpens: any[]): void {
    let changed = false;
    for (const l of vaultOpens) {
      const a = l.args; if (!a) continue;
      if (a.bookIdA !== undefined) { this.clober.vault.add(String(a.bookIdA)); changed = true; }
      if (a.bookIdB !== undefined) { this.clober.vault.add(String(a.bookIdB)); changed = true; }
    }
    if (vaultOpens.length) for (const [id, b] of this.clober.books) b.isVault = this.clober.vault.has(id);
    for (const l of bmOpens) {
      const a = l.args; if (!a) continue;
      if (this.clober.books.has(String(a.id))) continue;
      const b = cloberBookFromOpen(a, this.clober.vault);
      if (b) { this.clober.books.set(String(a.id), b); changed = true; }
    }
    if (changed) this.clober.markets = assembleCloberMarkets(this.clober.books);
  }

  private ingest(f: Fill): void {
    // Idempotent (H1): a fill already counted — a re-tail / gap-fill / restart
    // re-decode of the same on-chain event (now with a deterministic id) — must
    // never advance the volume buckets again. countedIds tracks the live window;
    // atomic persist keeps the cursor and volume consistent so a gap-fill never
    // re-tails counted blocks in the first place.
    if (this.countedIds.has(f.id)) return;
    this.countedIds.add(f.id);
    this.fills.push(f);
    if (this.fills.length > 400) {
      const dropped = this.fills.shift();
      if (dropped) this.countedIds.delete(dropped.id);
    }
    // Markouts only for genuinely-live fills (we observed the Bybit mid across
    // their horizons). Replayed/old fills keep markoutsBps=null (audit B2).
    if (Date.now() - f.ts < 10_000) this.pending.add(f);
    this.dirty.add(f);
    // Bucket by the fill's execution day, not wall-clock (audit B2). Closed
    // Clober days are subgraph-authoritative and refreshed each boot, so the
    // rare sub-second-across-midnight Clober fill self-heals on the next reseed.
    const d = this.dayFor(f.ts);
    if (f.protocol === 'LFJ') { d.lfj += f.usd; d.lfjSwaps += 1; }
    else {
      d.cloberVenue += f.usd; d.cloberSwaps += 1;
      if (f.scope === 'vault') { d.cloberVault += f.usd; d.cloberVaultSwaps += 1; }
    }
    d.swaps += 1;
    this.emitMsg({ ch: 'fill', data: f });
  }

  /** Find/create the daily bucket for a fill's execution timestamp (audit B2). */
  private dayFor(tsMs: number): DailyVolume {
    const day = utcDay(tsMs);
    let d = this.days.find((x) => x.utcDay === day);
    if (!d) {
      d = this.emptyDay(day, day === utcDay());
      this.days.push(d);
      this.days.sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
    }
    return d;
  }

  /** Join each pending fill to the Bybit mid at each horizon as it ages. */
  private ageMarkouts(): void {
    const now = Date.now();
    for (const f of [...this.pending]) {
      const ss = f.side === 'buy' ? 1 : -1;
      let changed = false, complete = true;
      for (let i = 0; i < MARKOUT_HORIZONS.length; i++) {
        if (f.markoutsBps[i] != null) continue;
        const at = f.ts + MARKOUT_HORIZONS[i] * 1000;
        if (now < at) { complete = false; continue; }
        const mid = this.midNear(at);
        f.markoutsBps[i] = mid <= 0 || f.execPx <= 0 ? 0 : ss * (mid / f.execPx - 1) * 1e4;
        changed = true;
      }
      if (changed) { this.dirty.add(f); this.emitMsg({ ch: 'fill', data: f }); }
      if (complete) this.pending.delete(f);
    }
  }
  private midNear(t: number): number {
    let best = 0, bestDt = Infinity;
    for (const s of this.midHist) { const dt = Math.abs(s.t - t); if (dt < bestDt) { bestDt = dt; best = s.mid; } }
    return best || this.bybit.mid();
  }

  /** Today's bucket — rolls the previous day closed at UTC midnight. */
  private today(): DailyVolume {
    const day = utcDay();
    let d = this.days[this.days.length - 1];
    if (!d || d.utcDay !== day) {
      if (d) d.partial = false;
      d = this.emptyDay(day, true);
      this.days.push(d);
    }
    return d;
  }
}
