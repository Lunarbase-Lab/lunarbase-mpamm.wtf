import { BaseSource } from './index.js';
import {
  MARKETS, SIZES_USD, MARKOUT_HORIZONS, ASSETS, pairOf,
  type DataSourceMode, type MarketState, type QuoteSnapshot, type QuoteRow, type Fill, type DailyVolume,
} from '@shared';
import { config } from '../config.js';
import { publicClient, getLogsChunked, probeChain, blockAtOrAfter } from '../chain/rpc.js';
import { UsdPricer } from '../pricer.js';
import { VolumeStore } from '../db.js';
import { utcDay, annotateCex } from '../util.js';
import { ADAPTERS, REFERENCES, venueMeta, venueIds, validateRegistry } from '../venues/registry.js';
import type { AdapterContext, LogBundle, LogSource, VenueAdapter } from '../venues/adapter.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

  private pricer = new UsdPricer((key) => REFERENCES.assetUsd(key));
  private store = new VolumeStore(config.dbPath);
  /** shared infra handed to every adapter (they don't import globals). */
  private ctx: AdapterContext = {
    client: publicClient,
    getLogs: getLogsChunked,
    pricer: this.pricer,
    config,
    log: (m: string) => this.notes.push(m),
  };

  private quotes: QuoteSnapshot = { block: 0, monUsd: 0, ts: 0, rows: [] };
  private days: DailyVolume[] = [];
  private fills: Fill[] = [];
  private pending = new Set<Fill>();
  private dirty = new Set<Fill>();
  /** ids already counted into the volume buckets (kept in sync with the fills
   *  window) — makes ingest idempotent so a re-decode never double-counts. */
  private countedIds = new Set<string>();
  private midHist = new Map<string, { t: number; mid: number }[]>(); // CEX mid history per base asset
  private lastBlock = 0n;
  /** chain head captured at boot — the upper bound for on-chain backfill (the
   *  live tail owns every block after it, so the two never overlap). */
  private bootHead = 0n;
  private timer?: ReturnType<typeof setInterval>;
  private persistTimer?: ReturnType<typeof setInterval>;
  private rediscoverTimer?: ReturnType<typeof setInterval>;
  private tickRunning = false;
  private notes: string[] = [];
  private block = 0;
  /** all registered venue ids — a fill/quote carrying an unknown id is dropped
   *  (a plugin bug must not silently store data the UI can't render). */
  private knownVenueIds = new Set<string>();

  async start(): Promise<void> {
    // Fail loud on a misconfigured registry (duplicate/invalid venue id) before
    // touching the network — a colliding id would silently merge two venues.
    validateRegistry();
    this.knownVenueIds = venueIds();
    // Fail fast on an unreachable/wrong chain (spec §8) rather than half-start.
    const probe = await probeChain();
    if (!probe.ok) throw new Error(`Monad RPC sanity check failed (${probe.reason}). Set DATA_SOURCE=sim to run offline.`);

    await REFERENCES.start();
    // discover every venue's markets/pools (adapters hold their own state).
    for (const a of ADAPTERS) {
      try { await a.discover(this.ctx); }
      catch (e) { this.notes.push(`${a.venues()[0]?.name ?? 'venue'} discovery failed: ${(e as Error).message}`); }
    }

    await this.initHistory();

    await this.poll().catch(() => undefined);
    this.timer = setInterval(() => { void this.tick(); }, config.quoteIntervalMs);
    this.persistTimer = setInterval(() => this.persist(), config.persistMs);
    this.rediscoverTimer = setInterval(() => { void this.rediscover(); }, config.rediscoverMs);
    // seed deep history in the BACKGROUND — never blocks boot or the live tail.
    if (config.backfillEnabled) void this.backfillOnchain();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    if (this.rediscoverTimer) clearInterval(this.rediscoverTimer);
    this.persist();
    REFERENCES.stop();
    this.store.close();
  }

  /** Periodically re-run each adapter's discover() so mid-run or missed pool
   *  state self-heals from its authoritative source (review #2). Adapters merge
   *  (never wipe) their cache, so a transient failure here is harmless. */
  private async rediscover(): Promise<void> {
    for (const a of ADAPTERS) {
      try { await a.discover(this.ctx); }
      catch (e) { this.noteOnce(`${a.venues()[0]?.name ?? 'venue'} re-discovery failed: ${(e as Error).message}`); }
    }
  }

  getState(): MarketState {
    return {
      chainId: 143, block: this.block, monUsd: REFERENCES.assetUsd('MON'), monChangePct: REFERENCES.changePctFor('MON'),
      takerBps: config.takerBps, markets: [...MARKETS], sizesUsd: [...SIZES_USD],
      quoteCadenceMs: config.quoteIntervalMs, source: 'live', venues: venueMeta(), notes: this.notes,
    };
  }
  getQuotes(): QuoteSnapshot { return this.quotes; }
  getFills(): Fill[] { return this.fills; }
  getVolume(): DailyVolume[] { return this.days.map((d) => ({ ...d, byVenue: { ...d.byVenue } })); }

  // ── history: load + seed + resume (persist-forward indexer) ─────────────────
  private async initHistory(): Promise<void> {
    // 0. prune any venue that left the registry (non-destructive — every
    //    remaining venue's history is kept, unlike a schema reset). Runs before
    //    we load days so a removed venue's stale rows never reach the UI/totals.
    const pruned = this.store.reconcileVenues([...this.knownVenueIds]);
    if (pruned.volume || pruned.fills) this.notes.push(`pruned ${pruned.volume} volume row(s) + ${pruned.fills} fill(s) for removed venue(s)`);
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
    const seededFills: Fill[] = [];
    for (const a of ADAPTERS) {
      if (!a.backfill) continue;
      const allowed = new Set(a.venues().map((v) => v.id)); // ids this adapter may emit
      try {
        const bf = await a.backfill(this.ctx, config.seedSinceUtc);
        for (const bd of bf.days ?? []) {
          if (bd.utcDay >= today) continue; // today is owned by live tailing
          let row = this.days.find((d) => d.utcDay === bd.utcDay);
          if (!row) { row = this.emptyDay(bd.utcDay, false); this.days.push(row); }
          for (const [venueId, vd] of Object.entries(bd.byVenue)) {
            if (!allowed.has(venueId)) { this.notes.push(`dropped backfill volume for foreign venue '${venueId}'`); continue; }
            row.byVenue[venueId] = { usd: vd.usd, swaps: vd.swaps ?? 0 };
          }
          row.partial = false;
          seeded++;
        }
        // historical fills → the DB, so the DB-backed leaderboard/tape queries
        // (queryFills) actually see them (review #2). Their volume is carried by
        // bf.days, so they are NOT ingested (no double-count), and their
        // closed-day blocks sit before the live tail cursor (never re-decoded).
        for (const f of bf.fills ?? []) {
          if (!allowed.has(f.venueId)) { this.notes.push(`dropped backfill fill for foreign venue '${f.venueId}'`); continue; }
          seededFills.push(f);
        }
      } catch (e) {
        this.notes.push(`${a.venues()[0]?.name ?? 'venue'} backfill unavailable (${(e as Error).message}); history grows forward`);
      }
    }
    if (seededFills.length) {
      this.store.upsertFills(seededFills);
      // Backfill-fills markout contract (review #3): only a fill whose horizons are
      // still in the FUTURE may be aged against the live mid. Historical closed-day
      // fills (horizons elapsed) are NOT queued — their markouts stay as the adapter
      // supplied them (typically null), so they're tape-visible but excluded from
      // markout/leaderboard stats (never fabricated from a much-later mid).
      for (const f of seededFills) if (this.hasFutureMarkoutHorizon(f, bootMs)) this.pending.add(f);
    }
    if (seeded) this.notes.push(`seeded ${seeded} closed day-row(s) from adapter backfill; on-chain-only venues accumulate forward`);
    this.days.sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
    this.today(); // ensure today's partial bucket, rolling any stale "today" closed
    this.reconcileSwapCounts(); // derive per-venue swap counts from retained + backfilled fills
    this.store.upsertMany(this.days);

    // 3. resume point — same-day gap-fill, else start at tip
    const head = await publicClient.getBlockNumber();
    this.block = Number(head);
    this.bootHead = head; // upper bound for the background backfill (tail owns > head)
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

  /** push a note at most once — per-tick drop reasons must not spam state.notes. */
  private noteOnce(msg: string): void { if (!this.notes.includes(msg)) this.notes.push(msg); }

  /** keep only items whose venueId is one this adapter declared — a foreign id
   *  (plugin bug) is dropped with a one-time note, never silently stored (review #3). */
  private ownVenues<T extends { venueId: string }>(a: VenueAdapter, items: T[], kind: string): T[] {
    const allowed = new Set(a.venues().map((v) => v.id));
    return items.filter((x) => {
      if (allowed.has(x.venueId)) return true;
      this.noteOnce(`${a.venues()[0]?.name ?? 'adapter'} emitted a ${kind} for foreign venue '${x.venueId}' — dropped`);
      return false;
    });
  }

  /**
   * Derive per-venue swap counts from the retained fills — the authoritative
   * per-fill record — so the protocol breakdown is accurate across the retention
   * window immediately. Days with no retained fills (older than retention, or a
   * subgraph-seeded day) keep swaps 0: we have their volume, not the count.
   */
  private reconcileSwapCounts(): void {
    const byDay = new Map<string, Map<string, number>>();
    for (const c of this.store.fillCountsByDayVenue()) {
      let m = byDay.get(c.utcDay); if (!m) { m = new Map(); byDay.set(c.utcDay, m); }
      m.set(c.venueId, c.swaps);
    }
    for (const d of this.days) {
      const m = byDay.get(d.utcDay);
      if (!m) continue;
      for (const [venueId, swaps] of m) {
        (d.byVenue[venueId] ??= { usd: 0, swaps: 0 }).swaps = swaps;
      }
    }
  }

  // ── background on-chain backfill ─────────────────────────────────────────────
  /**
   * Seed deep daily-volume history for adapters that declared `backfillFromUtc`
   * but have no keyless subgraph — by replaying their Swap logs on-chain. Runs
   * OFF the boot path (never blocks the dashboard or the live tail): chunked +
   * paced under the RPC's limits, resumable across restarts, and self-healing
   * (retried each boot until `backfill_done_<venue>` is set).
   */
  private async backfillOnchain(): Promise<void> {
    for (const a of ADAPTERS) {
      const sinceUtc = a.backfillFromUtc;
      const vid = a.venues()[0]?.id ?? '';
      const name = a.venues()[0]?.name ?? vid;
      if (!sinceUtc || !vid || this.store.getMeta(`backfill_done_${vid}`) === '1') continue;
      let sources: LogSource[];
      try { sources = a.logSources().filter((s) => (s.kind ?? 'fills') === 'fills'); }
      catch { this.noteOnce(`${name} backfill deferred — pools not discovered yet`); continue; }
      if (!sources.length) { this.store.setMeta(`backfill_done_${vid}`, '1'); continue; }
      try { await this.backfillAdapter(a, vid, name, sinceUtc, sources); }
      catch (e) { this.noteOnce(`${name} backfill paused (${(e as Error).message}); resumes next boot`); }
    }
  }

  private async backfillAdapter(a: VenueAdapter, vid: string, name: string, sinceUtc: string, sources: LogSource[]): Promise<void> {
    const end = this.bootHead;
    if (end <= 0n) return;
    const startSec = Math.floor(Date.parse(`${sinceUtc}T00:00:00Z`) / 1000);
    if (!Number.isFinite(startSec)) { this.noteOnce(`${name} backfill: invalid backfillFromUtc '${sinceUtc}'`); return; }

    // Resume from a DAY-ALIGNED block: re-scan the in-progress day from its start
    // so mergeBackfill's SET-per-day stays idempotent (earlier days already done).
    let from = await blockAtOrAfter(startSec, end);
    const cur = this.store.getMeta(`backfill_cursor_${vid}`);
    if (cur) {
      const cb = BigInt(cur);
      if (cb > from && cb <= end + 1n) {
        try {
          const b = await publicClient.getBlock({ blockNumber: cb > end ? end : cb });
          const daySec = Math.floor(Date.parse(`${utcDay(Number(b.timestamp) * 1000)}T00:00:00Z`) / 1000);
          from = await blockAtOrAfter(daySec, end);
        } catch { /* fall back to the full-range start */ }
      }
    }
    if (from > end) { this.store.setMeta(`backfill_done_${vid}`, '1'); return; }

    const today = utcDay();
    const acc = new Map<string, { usd: number; swaps: number }>(); // closed utcDay -> totals
    let chunk = BigInt(config.backfillChunk);
    const floor = BigInt(config.getLogsChunk);
    let cursor = from;
    let sinceMerge = 0;
    this.noteOnce(`${name}: on-chain backfill ${sinceUtc} — blocks ${from}→${end}`);

    while (cursor <= end) {
      const to = cursor + chunk - 1n > end ? end : cursor + chunk - 1n;
      // fetch every fill source over [cursor,to]; shrink the span on a range error,
      // back off on a transient error, so we stay under the RPC's caps.
      let batches: any[][] | null = null;
      let tries = 0;
      while (batches === null) {
        try {
          batches = await Promise.all(sources.map((s) =>
            publicClient.getLogs({ address: s.address as any, fromBlock: cursor, toBlock: to, events: s.events as any } as any) as Promise<any[]>));
        } catch (e) {
          if (chunk > floor) { chunk = chunk / 2n > floor ? chunk / 2n : floor; break; } // too wide → shrink, retry cursor
          if (++tries <= 5) { await sleep(config.backfillPaceMs * 10 * tries); continue; } // transient → back off
          throw e; // give up this adapter (retried next boot)
        }
      }
      if (batches === null) continue; // shrank — retry the same cursor with a smaller span

      const all = batches.flat();
      if (all.length) {
        // ONE timestamp per chunk is enough for DAILY bucketing (a chunk spans
        // ≤ chunk blocks ≈ a few minutes) and keeps a high-volume venue's full
        // backfill to ~1 getBlock/chunk instead of one per fill. Anchor on any log
        // block that resolves (retry + try siblings) so a flaky/missing getBlock —
        // a range-cap RPC can return a log for a block it momentarily 404s — never
        // aborts a multi-million-block backfill.
        let anchorMs = NaN;
        for (const bn of new Set<bigint>(all.map((l) => l.blockNumber as bigint))) {
          for (let i = 0; i < 3 && !Number.isFinite(anchorMs); i++) {
            try { anchorMs = Number((await publicClient.getBlock({ blockNumber: bn })).timestamp) * 1000; }
            catch { await sleep(config.backfillPaceMs * 5 * (i + 1)); }
          }
          if (Number.isFinite(anchorMs)) break;
        }
        if (Number.isFinite(anchorMs)) {
          const tsOf = () => anchorMs; // chunk-level ts — daily bucketing only
          const bundle: LogBundle = {};
          sources.forEach((s, i) => { bundle[s.key] = batches![i]; });
          const fills = this.ownVenues(a, await a.decode(this.ctx, bundle, tsOf, new Set()), 'backfill fill');
          for (const f of fills) {
            const day = utcDay(f.ts);
            if (day >= today) continue; // today is owned by the live tail — no overlap
            const e = acc.get(day) ?? { usd: 0, swaps: 0 };
            e.usd += f.usd; e.swaps += 1; acc.set(day, e);
          }
        } else {
          this.noteOnce(`${name} backfill: block timestamps unresolved near ${cursor} — chunk skipped`);
        }
      }

      cursor = to + 1n;
      if (++sinceMerge >= config.backfillMergeEvery || cursor > end) {
        this.mergeBackfill(vid, acc);
        this.store.setMeta(`backfill_cursor_${vid}`, String(cursor));
        this.store.upsertMany(this.days);
        sinceMerge = 0;
      }
      await sleep(config.backfillPaceMs);
    }

    this.mergeBackfill(vid, acc);
    this.store.setMeta(`backfill_cursor_${vid}`, String(end + 1n));
    this.store.setMeta(`backfill_done_${vid}`, '1');
    this.store.upsertMany(this.days);
    this.notes.push(`${name}: backfill complete — ${acc.size} day(s) seeded`);
    this.emitMsg({ ch: 'volume', data: this.cloneDay(this.today()) }); // nudge connected clients
  }

  /** Merge accumulated backfill totals into this.days, SET per (day, venue):
   *  backfill is authoritative for a CLOSED day it fully scanned, and the live
   *  tail only ever writes today+, so a SET can never double-count. */
  private mergeBackfill(vid: string, acc: Map<string, { usd: number; swaps: number }>): void {
    for (const [day, tot] of acc) {
      let d = this.days.find((x) => x.utcDay === day);
      if (!d) { d = this.emptyDay(day, false); this.days.push(d); }
      d.byVenue[vid] = { usd: tot.usd, swaps: tot.swaps };
    }
    this.days.sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
  }

  /** Historical fills from the DB (the leaderboard/markouts query real windows). */
  queryFills(opts: { sinceMs?: number; limit?: number }): Fill[] {
    const sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) && opts.sinceMs > 0 ? opts.sinceMs : 0;
    const rawLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 1000;
    return this.store.fillsSince(sinceMs, Math.min(Math.floor(rawLimit), 50_000));
  }

  // ── poll loop ───────────────────────────────────────────────────────────────
  private async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      try { await this.poll(); } catch { /* keep ticking */ }
      try { await this.tailFills(); } catch (e) { this.noteOnce(`tail failed — holding cursor, retrying: ${(e as Error).message}`); }
      this.ageMarkouts();
      this.emitMsg({ ch: 'volume', data: this.cloneDay(this.today()) });
    } finally {
      this.tickRunning = false;
    }
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    const monUsd = REFERENCES.assetUsd('MON');
    // record each base asset's CEX mid history (the per-asset markout anchors).
    for (const key of Object.keys(ASSETS)) {
      const mid = REFERENCES.midFor(key);
      if (mid <= 0) continue;
      const h = this.midHist.get(key) ?? [];
      h.push({ t: now, mid });
      if (h.length > 400) h.shift();
      this.midHist.set(key, h);
    }

    const head = await publicClient.getBlockNumber();
    this.block = Number(head);

    const venueRows = (await Promise.all(ADAPTERS.map(async (a) => {
      if (!a.quote) return [] as QuoteRow[];
      const rows = await a.quote(this.ctx, config.sizesUsd).catch(() => [] as QuoteRow[]);
      return this.ownVenues(a, rows, 'quote'); // drop rows for ids the adapter didn't declare
    }))).flat();
    // benchmark rows for every pair, each routed to + tagged with its CEX (Bybit/Binance).
    const refRows = REFERENCES.quote(config.sizesUsd);
    annotateCex(venueRows, refRows); // spec §4.2 — matched per market, so each venue row hits its pair's CEX
    this.quotes = { block: this.block, monUsd, ts: now, rows: [...venueRows, ...refRows] };
    this.emitMsg({ ch: 'state', data: this.getState() });
    this.emitMsg({ ch: 'quotes', data: this.quotes });
  }

  // ── fills ───────────────────────────────────────────────────────────────────
  private async tailFills(): Promise<void> {
    // Defer the tail until at least one CEX reference is warm so markout anchors are
    // sound; lastBlock is not advanced, so the range is re-decoded once warm (audit C3).
    if (!Object.keys(ASSETS).some((k) => REFERENCES.assetUsd(k) > 0)) return;
    const head = await publicClient.getBlockNumber();
    if (head <= this.lastBlock) return;
    const from = this.lastBlock + 1n;

    // Fetch every adapter's declared log sources into a per-adapter bundle. Track
    // whether any REQUIRED (fill-producing) source failed: if so we must NOT
    // advance the cursor, or a transient RPC error would look like "no logs" and
    // silently lose those fills forever (review #1). Only attribution sources
    // are tolerated on failure; state/discovery sources are cursor-critical.
    let requiredFailed = false;
    const perAdapter = await Promise.all(ADAPTERS.map(async (a) => {
      const bundle: LogBundle = {};
      const all: any[] = [];
      const failed = new Set<string>(); // source keys whose fetch failed (surfaced to decode)
      await Promise.all(a.logSources().map(async (s) => {
        try {
          const logs = (await getLogsChunked({ address: s.address, fromBlock: from, toBlock: head, events: s.events as any })) as any[];
          bundle[s.key] = logs;
          all.push(...logs);
        } catch {
          bundle[s.key] = [];
          failed.add(s.key);
          // 'fills' + 'state' sources hold the cursor; only 'attribution' is tolerated.
          if (s.kind !== 'attribution') {
            requiredFailed = true;
            this.noteOnce(`${a.venues()[0]?.name ?? 'venue'} log source '${s.key}' failed — holding cursor, retrying`);
          }
        }
      }));
      return { a, bundle, all, failed };
    }));

    // ATOMIC (review #1): if any required (fills/state) source failed, skip the
    // ENTIRE cycle — do NOT resolve timestamps, decode, mutate adapter state,
    // ingest, emit, or advance the cursor. The identical range is re-tailed next
    // cycle once every required source is back, so a fill is never partially
    // decoded, and dedupe (countedIds) is not relied on across a held range.
    if (requiredFailed) return;

    // resolve block timestamps once for every block that carries a log (audit B2).
    const blocks = new Set<bigint>();
    for (const { all } of perAdapter) for (const l of all) blocks.add(l.blockNumber);
    let blockTs: Map<string, number>;
    try {
      blockTs = await this.blockTimes(blocks);
    } catch (e) {
      this.noteOnce(`block timestamp lookup failed — holding cursor, retrying: ${(e as Error).message}`);
      return;
    }
    const tsOf = (bn: bigint) => {
      const ts = blockTs.get(String(bn));
      if (ts == null) throw new Error(`missing block timestamp for ${bn}`);
      return ts;
    };

    const fresh: Fill[] = [];
    let decodeFailed = false;
    for (const { a, bundle, failed } of perAdapter) {
      try { fresh.push(...this.ownVenues(a, await a.decode(this.ctx, bundle, tsOf, failed), 'fill')); }
      catch (e) {
        decodeFailed = true;
        this.noteOnce(`${a.venues()[0]?.name ?? 'venue'} decode error — holding cursor, retrying: ${(e as Error).message}`);
      }
    }
    // Decode is cursor-critical too: if an adapter cannot decode this range, do
    // not count any fills from it and do not advance. The exact range is retried.
    if (decodeFailed) return;

    // every required source succeeded → advance the cursor and ingest.
    this.lastBlock = head;
    fresh.sort((a, b) => a.blockNumber - b.blockNumber);
    for (const f of fresh) this.ingest(f);
  }

  /** Block timestamps (ms) for the blocks that carry logs (audit B2). */
  private async blockTimes(blocks: Set<bigint>): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    await Promise.all([...blocks].map(async (bn) => {
      const b = await publicClient.getBlock({ blockNumber: bn });
      m.set(String(bn), Number(b.timestamp) * 1000);
    }));
    return m;
  }

  private ingest(f: Fill): void {
    // never store a fill for a venue the registry doesn't know (its volume would
    // be invisible in the UI / could merge into another venue) — review #3.
    if (!this.knownVenueIds.has(f.venueId)) { this.noteOnce(`dropped fill for unknown venue '${f.venueId}'`); return; }
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
    for (const f of [...this.pending]) {
      // an UNREGISTERED market has no CEX routing — never fall back to MON/Bybit
      // (a BTC fill aged vs a $0.02 mid would fabricate absurd markouts). Leave
      // its markouts null and stop tracking it (defense in depth; adapters gate
      // discovery/decode on the pair registry so this shouldn't be reachable).
      const base = pairOf(f.market)?.base;
      if (!base) { this.pending.delete(f); this.noteOnce(`fill market '${f.market}' is not a registered pair — markouts skipped`); continue; }
      const hist = this.midHist.get(base) ?? [];
      // A horizon that elapsed before we had any mid for THIS asset can't be
      // computed faithfully — leave it null rather than fabricate it (M1).
      const earliestMid = hist.length ? hist[0].t : now;
      const ss = f.side === 'buy' ? 1 : -1;
      let changed = false, complete = true;
      for (let i = 0; i < MARKOUT_HORIZONS.length; i++) {
        if (f.markoutsBps[i] != null) continue;
        const at = f.ts + MARKOUT_HORIZONS[i] * 1000;
        if (now < at) { complete = false; continue; }   // horizon not reached yet
        if (at < earliestMid) continue;                  // elapsed unobserved → leave null
        const mid = this.midNear(base, at);
        f.markoutsBps[i] = mid <= 0 || f.execPx <= 0 ? 0 : ss * (mid / f.execPx - 1) * 1e4;
        changed = true;
      }
      if (changed) { this.dirty.add(f); this.emitMsg({ ch: 'fill', data: f }); }
      if (complete) this.pending.delete(f);
    }
  }
  private midNear(base: string, t: number): number {
    const hist = this.midHist.get(base) ?? [];
    let best = 0, bestDt = Infinity;
    for (const s of hist) { const dt = Math.abs(s.t - t); if (dt < bestDt) { bestDt = dt; best = s.mid; } }
    return best || REFERENCES.midFor(base);
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
