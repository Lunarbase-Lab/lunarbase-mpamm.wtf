import { BaseSource } from './index.js';
import {
  MARKETS, SIZES_USD, MARKOUT_HORIZONS,
  type DataSourceMode, type MarketState, type QuoteSnapshot, type QuoteRow, type Fill, type DailyVolume,
} from '@shared';
import { config } from '../config.js';
import { publicClient, getLogsChunked, probeChain } from '../chain/rpc.js';
import { UsdPricer } from '../pricer.js';
import { VolumeStore } from '../db.js';
import { utcDay, annotateCex } from '../util.js';
import { ADAPTERS, REFERENCE, venueMeta } from '../venues/registry.js';
import type { AdapterContext, LogBundle } from '../venues/adapter.js';

/**
 * LiveDataSource — real Monad RPC + CEX reference, run as a persist-forward
 * indexer. It is entirely venue-agnostic: every venue is a registered adapter
 * (server/src/venues/registry.ts) and the core only ever sees `venueId`.
 *
 *  - quotes: each adapter's quote() (contract reads) + the CEX reference walk.
 *  - fills:  each adapter declares logSources(); the core getLogs's them and
 *    hands them back to decode(); fills are priced by the adapter, bucketed into
 *    UTC-day per-venue volume, and joined to the reference mid for markouts.
 *  - history: the SQLite DB is authoritative. On boot we load persisted days +
 *    lastProcessedBlock, run each adapter's optional backfill() (deep history
 *    seed), and either gap-fill from the last processed block or start forward.
 */
export class LiveDataSource extends BaseSource {
  readonly mode: DataSourceMode = 'live';

  private pricer = new UsdPricer(() => REFERENCE.monUsd());
  private store = new VolumeStore(config.dbPath);
  /** shared infra handed to every adapter (they don't import globals). */
  private ctx: AdapterContext = {
    client: publicClient,
    getLogs: getLogsChunked,
    pricer: this.pricer,
    config,
    log: (m: string) => this.notes.push(m),
    referenceMid: () => REFERENCE.mid(),
  };

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

    await REFERENCE.start();
    // discover every venue's markets/pools (adapters hold their own state).
    for (const a of ADAPTERS) {
      try { await a.discover(this.ctx); }
      catch (e) { this.notes.push(`${a.venues()[0]?.name ?? 'venue'} discovery failed: ${(e as Error).message}`); }
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
    REFERENCE.stop();
    this.store.close();
  }

  getState(): MarketState {
    return {
      chainId: 143, block: this.block, monUsd: REFERENCE.monUsd(), monChangePct: REFERENCE.changePct(),
      takerBps: config.takerBps, markets: [...MARKETS], sizesUsd: [...SIZES_USD],
      quoteCadenceMs: config.quoteIntervalMs, source: 'live', venues: venueMeta(), notes: this.notes,
    };
  }
  getQuotes(): QuoteSnapshot { return this.quotes; }
  getFills(): Fill[] { return this.fills; }
  getVolume(): DailyVolume[] { return this.days.map((d) => ({ ...d, byVenue: { ...d.byVenue } })); }

  // ── history: load + seed + resume (persist-forward indexer) ─────────────────
  private async initHistory(): Promise<void> {
    // 1. authoritative persisted history
    this.days = this.store.all();
    // load recent fills for live serving; drop rows past the retention window
    this.store.pruneFills(Date.now() - config.fillsRetentionDays * 86_400_000);
    this.fills = this.store.recentFills(400);
    // seed the dedup guard with the persisted window so a gap-fill re-decode of
    // already-counted fills won't re-count them.
    for (const f of this.fills) this.countedIds.add(f.id);
    // Resume markout aging across a restart (M1): a fill persisted with only its
    // early horizons must go back on the pending queue if a later horizon is
    // still in the future, or ageMarkouts would leave those cells null forever.
    const bootMs = Date.now();
    for (const f of this.fills) if (this.hasFutureMarkoutHorizon(f, bootMs)) this.pending.add(f);

    // 2. per-adapter historical backfill (deep-history seed, e.g. a subgraph).
    const today = utcDay();
    let seeded = 0;
    for (const a of ADAPTERS) {
      if (!a.backfill) continue;
      try {
        const bf = await a.backfill(this.ctx, config.seedSinceUtc);
        for (const bd of bf.days ?? []) {
          if (bd.utcDay >= today) continue; // today is owned by live tailing
          let row = this.days.find((d) => d.utcDay === bd.utcDay);
          if (!row) { row = this.emptyDay(bd.utcDay, false); this.days.push(row); }
          for (const [venueId, vd] of Object.entries(bd.byVenue)) row.byVenue[venueId] = { usd: vd.usd, swaps: vd.swaps ?? 0 };
          row.partial = false;
          seeded++;
        }
        for (const f of bf.fills ?? []) if (!this.countedIds.has(f.id)) { this.countedIds.add(f.id); this.fills.push(f); }
      } catch (e) {
        this.notes.push(`${a.venues()[0]?.name ?? 'venue'} backfill unavailable (${(e as Error).message}); history grows forward`);
      }
    }
    if (seeded) this.notes.push(`seeded ${seeded} closed day-row(s) from adapter backfill; on-chain-only venues accumulate forward`);
    this.days.sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
    this.today(); // ensure today's partial bucket, rolling any stale "today" closed
    this.reconcileSwapCounts(); // derive per-venue swap counts from retained fills
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

  /** A fresh zeroed daily bucket (venue slices fill in as fills land). */
  private emptyDay(day: string, partial: boolean): DailyVolume {
    return { utcDay: day, byVenue: {}, partial };
  }

  /**
   * Derive per-venue swap counts from the retained fills — the authoritative
   * per-fill record — so the protocol breakdown is accurate across the retention
   * window immediately. Days with no retained fills (older than retention, or a
   * subgraph-seeded day) keep swaps 0: we have their volume, not the count.
   */
  private reconcileSwapCounts(): void {
    const byDay = new Map<string, Map<string, number>>();
    for (const f of this.store.fillsSince(0, 50_000)) {
      const day = utcDay(f.ts);
      let m = byDay.get(day); if (!m) { m = new Map(); byDay.set(day, m); }
      m.set(f.venueId, (m.get(f.venueId) ?? 0) + 1);
    }
    for (const d of this.days) {
      const m = byDay.get(d.utcDay);
      if (!m) continue;
      for (const [venueId, swaps] of m) {
        (d.byVenue[venueId] ??= { usd: 0, swaps: 0 }).swaps = swaps;
      }
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
    this.emitMsg({ ch: 'volume', data: this.cloneDay(this.today()) });
  }

  private async poll(): Promise<void> {
    const monUsd = REFERENCE.monUsd();
    if (monUsd <= 0) return;
    this.midHist.push({ t: Date.now(), mid: REFERENCE.mid() });
    if (this.midHist.length > 400) this.midHist.shift();

    const head = await publicClient.getBlockNumber();
    this.block = Number(head);

    const venueRows = (await Promise.all(
      ADAPTERS.map((a) => (a.quote ? a.quote(this.ctx, config.sizesUsd).catch(() => [] as QuoteRow[]) : Promise.resolve([] as QuoteRow[]))),
    )).flat();
    const refRows = REFERENCE.quote(this.ctx, config.sizesUsd);
    annotateCex(venueRows, refRows); // spec §4.2 (audit I1)
    this.quotes = { block: this.block, monUsd, ts: Date.now(), rows: [...venueRows, ...refRows] };
    this.emitMsg({ ch: 'state', data: this.getState() });
    this.emitMsg({ ch: 'quotes', data: this.quotes });
  }

  // ── fills ───────────────────────────────────────────────────────────────────
  private async tailFills(): Promise<void> {
    // Defer the tail until the reference mid is warm so markout anchors are sound;
    // lastBlock is not advanced, so the range is re-decoded once warm (audit C3).
    if (REFERENCE.monUsd() <= 0) return;
    const head = await publicClient.getBlockNumber();
    if (head <= this.lastBlock) return;
    const from = this.lastBlock + 1n;

    // fetch every adapter's declared log sources into a per-adapter bundle.
    const perAdapter = await Promise.all(ADAPTERS.map(async (a) => {
      const bundle: LogBundle = {};
      const all: any[] = [];
      await Promise.all(a.logSources().map(async (s) => {
        const logs = (await getLogsChunked({ address: s.address, fromBlock: from, toBlock: head, events: s.events as any }).catch(() => [] as unknown[])) as any[];
        bundle[s.key] = logs;
        all.push(...logs);
      }));
      return { a, bundle, all };
    }));

    // resolve block timestamps once for every block that carries a log (audit B2).
    const blocks = new Set<bigint>();
    for (const { all } of perAdapter) for (const l of all) blocks.add(l.blockNumber);
    const blockTs = await this.blockTimes(blocks);
    const tsOf = (bn: bigint) => blockTs.get(String(bn)) ?? Date.now();

    const fresh: Fill[] = [];
    for (const { a, bundle } of perAdapter) {
      try { fresh.push(...(await a.decode(this.ctx, bundle, tsOf))); }
      catch (e) { this.notes.push(`${a.venues()[0]?.name ?? 'venue'} decode error: ${(e as Error).message}`); }
    }

    this.lastBlock = head;
    fresh.sort((a, b) => a.blockNumber - b.blockNumber);
    for (const f of fresh) this.ingest(f);
  }

  /** Block timestamps (ms) for the blocks that carry logs (audit B2). */
  private async blockTimes(blocks: Set<bigint>): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    await Promise.all([...blocks].map(async (bn) => {
      try { const b = await publicClient.getBlock({ blockNumber: bn }); m.set(String(bn), Number(b.timestamp) * 1000); } catch { /* fall back to now */ }
    }));
    return m;
  }

  private ingest(f: Fill): void {
    // Idempotent (H1): a fill already counted — a re-tail / gap-fill / restart
    // re-decode of the same on-chain event (deterministic id) — must never
    // advance the volume buckets again.
    if (this.countedIds.has(f.id)) return;
    this.countedIds.add(f.id);
    this.fills.push(f);
    if (this.fills.length > 400) {
      const dropped = this.fills.shift();
      if (dropped) this.countedIds.delete(dropped.id);
    }
    // Keep aging any fill that still has a recoverable (future) markout horizon.
    if (this.hasFutureMarkoutHorizon(f)) this.pending.add(f);
    this.dirty.add(f);
    // Bucket by the fill's execution day, keyed generically by venueId.
    const d = this.dayFor(f.ts);
    const vd = (d.byVenue[f.venueId] ??= { usd: 0, swaps: 0 });
    vd.usd += f.usd;
    vd.swaps += 1;
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

  /** True while a fill still has a null markout horizon whose mark time is in the
   *  future — i.e. still observable, so it's worth keeping on the pending queue. */
  private hasFutureMarkoutHorizon(f: Fill, now = Date.now()): boolean {
    return MARKOUT_HORIZONS.some((h, i) => f.markoutsBps[i] == null && now < f.ts + h * 1000);
  }

  /** Join each pending fill to the reference mid at each horizon as it ages. */
  private ageMarkouts(): void {
    const now = Date.now();
    // A horizon that elapsed before we had any mid to observe it can't be
    // computed faithfully — leave it null rather than fabricate it (M1).
    const earliestMid = this.midHist.length ? this.midHist[0].t : now;
    for (const f of [...this.pending]) {
      const ss = f.side === 'buy' ? 1 : -1;
      let changed = false, complete = true;
      for (let i = 0; i < MARKOUT_HORIZONS.length; i++) {
        if (f.markoutsBps[i] != null) continue;
        const at = f.ts + MARKOUT_HORIZONS[i] * 1000;
        if (now < at) { complete = false; continue; }   // horizon not reached yet
        if (at < earliestMid) continue;                  // elapsed unobserved → leave null
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
    return best || REFERENCE.mid();
  }

  private cloneDay(d: DailyVolume): DailyVolume { return { ...d, byVenue: { ...d.byVenue } }; }

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
