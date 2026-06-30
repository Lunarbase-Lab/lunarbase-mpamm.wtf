import { BaseSource } from './index.js';
import {
  MARKETS, SIZES_USD, MARKOUT_HORIZONS, ADDR,
  type DataSourceMode, type MarketState, type QuoteSnapshot, type QuoteRow, type Fill, type DailyVolume,
} from '@shared';
import { config } from '../config.js';
import { publicClient, getLogsChunked, probeChain } from '../chain/rpc.js';
import { lbPairAbi, bookManagerAbi } from '../chain/abis.js';
import { BybitFeed } from '../bybit.js';
import { UsdPricer } from '../pricer.js';
import { discoverLfj, quoteLfj, decodeLfjSwap, type LbMarket } from '../venues/lfj.js';
import { discoverClober, quoteClober, decodeCloberTake, type CloberBook, type CloberMarket } from '../venues/clober.js';
import { VolumeStore } from '../db.js';
import { seedCloberDaily } from '../seed/subgraph.js';
import { utcDay } from '../util.js';

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

    await this.initHistory();

    await this.poll().catch(() => undefined);
    this.timer = setInterval(() => { void this.tick(); }, config.quoteIntervalMs);
    this.persistTimer = setInterval(() => this.persist(), config.persistMs);

    // Clober quoting/decoding needs a book cache; discovery is slow on the
    // public RPC (range-capped getLogs), so resolve it in the background.
    void discoverClober(2000)
      .then((c) => {
        this.clober = c;
        if (!c.markets.length) this.notes.push('no recent Clober books found on public RPC (live Clober quotes need an archive node or subgraph book seed)');
        else this.notes.push(`Clober: ${c.markets.length} live market(s), ${c.vault.size} vault book id(s)`);
      })
      .catch(() => this.notes.push('Clober discovery degraded'));
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

    // 2. refresh closed Clober days from the subgraph (cheap deep-history seed)
    const today = utcDay();
    try {
      const seed = await seedCloberDaily(config.subgraphUrl, config.seedSinceUtc);
      let seeded = 0;
      for (const [day, cd] of seed) {
        if (day >= today) continue; // today is owned by live tailing
        let row = this.days.find((d) => d.utcDay === day);
        if (!row) { row = { utcDay: day, lfj: 0, cloberVenue: 0, cloberVault: 0, swaps: 0, partial: false }; this.days.push(row); }
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
      this.store.upsertMany(this.days);
      this.store.setMeta('lastProcessedBlock', String(this.lastBlock));
      this.store.setMeta('lastProcessedDay', utcDay());
    } catch { /* non-fatal */ }
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
    const head = await publicClient.getBlockNumber();
    if (head <= this.lastBlock) return;
    const from = this.lastBlock + 1n;
    const monUsd = this.bybit.monUsd();
    const fresh: Fill[] = [];

    if (this.lfj.length) {
      const swapEvent = lbPairAbi.find((x: any) => x.type === 'event' && x.name === 'Swap');
      const logs = (await getLogsChunked({
        address: this.lfj.map((m) => m.pair) as `0x${string}`[], fromBlock: from, toBlock: head, events: [swapEvent],
      })) as any[];
      for (const l of logs) {
        const m = this.lfjByAddr.get(String(l.address).toLowerCase());
        if (!m) continue;
        const f = decodeLfjSwap(l, m, this.pricer, monUsd);
        if (f) fresh.push(f);
      }
    }

    if (this.clober.books.size) {
      const takeEvent = bookManagerAbi.find((x: any) => x.type === 'event' && x.name === 'Take');
      const logs = (await getLogsChunked({
        address: ADDR.bookManager as `0x${string}`, fromBlock: from, toBlock: head, events: [takeEvent],
      })) as any[];
      for (const l of logs) {
        const f = decodeCloberTake(l, this.clober.books, this.clober.vault, this.pricer, monUsd);
        if (f) fresh.push(f);
      }
    }

    this.lastBlock = head;
    fresh.sort((a, b) => a.blockNumber - b.blockNumber);
    for (const f of fresh) this.ingest(f);
  }

  private ingest(f: Fill): void {
    this.fills.push(f);
    if (this.fills.length > 400) this.fills.shift();
    this.pending.add(f);
    const d = this.today();
    if (f.protocol === 'LFJ') d.lfj += f.usd;
    else { d.cloberVenue += f.usd; if (f.scope === 'vault') d.cloberVault += f.usd; }
    d.swaps += 1;
    this.emitMsg({ ch: 'fill', data: f });
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
      if (changed) this.emitMsg({ ch: 'fill', data: f });
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
      d = { utcDay: day, lfj: 0, cloberVenue: 0, cloberVault: 0, swaps: 0, partial: true };
      this.days.push(d);
    }
    return d;
  }
}
