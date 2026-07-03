import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DailyVolume, Fill } from '@shared';

type Stmt = ReturnType<DatabaseSync['prepare']>;

/**
 * SQLite persistence (spec §6.2). The DB is the source of truth for history:
 * daily-volume aggregates + the lastProcessedBlock cursor, and decoded fills
 * (the tape/markouts/leaderboard are expensive to re-derive — log decode + a
 * Bybit-mid join — so they're stored, not just held in a live window). The
 * current quote matrix stays in memory (replace-on-poll, cheap to refetch).
 *
 * Schema is venue-agnostic (long format): daily volume is one row per
 * (day, venue_id), and a fill carries a `venue_id` — so adding/removing a venue
 * never changes the table shape. A venue that leaves the registry is pruned
 * non-destructively on boot (`reconcileVenues`), keeping every OTHER venue's
 * history. `SCHEMA_VERSION` only gates a true STRUCTURAL change (columns / PK);
 * on such a bump we start fresh (Clober re-seeds from the subgraph, on-chain
 * venues rebuild forward) — a venue swap alone no longer resets anything.
 */
const SCHEMA_VERSION = '3';

/**
 * Version of the MARKOUT MODEL — what a fill's `markouts_bps` were marked
 * against. Bump when the benchmark itself changes meaning (not on schema
 * changes): on mismatch, persisted fills keep their volume/tape data but their
 * markouts are reset to nulls — horizons that elapsed under the old model are
 * excluded (never recomputed against a mid history we don't have, and never
 * mixed with new-model markouts in the leaderboard/markout stats), while fills
 * young enough re-age naturally against the new model.
 *
 *  'pair-mid-1' — markouts vs the PAIR-terms CEX mid (wrap basis + stable
 *                 cross), replacing raw USDT mids (~10bps different on USDC
 *                 pairs — old and new values are not comparable).
 */
const MARKOUT_MODEL_VERSION = 'pair-mid-1';

export class VolumeStore {
  private db: DatabaseSync;
  private dayStmt: Stmt;
  private dayMetaStmt: Stmt;
  private metaStmt: Stmt;
  private fillStmt: Stmt;

  constructor(path = 'data/mpamm.db') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);

    // meta first (holds the schema version + the indexer cursor)
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
    const ver = (this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined)?.value;
    if (ver !== SCHEMA_VERSION) {
      // start fresh on a schema change: drop the data tables and clear the cursor
      // so the indexer cold-starts (the venue registry defines the new shape).
      this.db.exec(`DROP TABLE IF EXISTS daily_volume; DROP TABLE IF EXISTS fills; DROP TABLE IF EXISTS day_meta; DELETE FROM meta;`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_volume (
        utc_day  TEXT    NOT NULL,
        venue_id TEXT    NOT NULL,
        usd      REAL    NOT NULL DEFAULT 0,
        swaps    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (utc_day, venue_id)
      );
      CREATE TABLE IF NOT EXISTS day_meta (
        utc_day TEXT PRIMARY KEY,
        partial INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS fills (
        id           TEXT PRIMARY KEY,
        ts           INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        venue_id     TEXT NOT NULL,
        market       TEXT NOT NULL,
        side         TEXT NOT NULL,
        category     TEXT NOT NULL,
        usd          REAL NOT NULL,
        base_amount  REAL NOT NULL,
        exec_px      REAL NOT NULL,
        tx_hash      TEXT NOT NULL,
        to_label     TEXT NOT NULL,
        pool         TEXT NOT NULL,
        markouts_bps TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fills_ts ON fills (ts);
    `);
    this.db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SCHEMA_VERSION);

    // markout-model migration: retained fills marked under an older model keep
    // their volume/tape data, but their markouts are nulled — old-model bps must
    // never mix with new-model bps in the markout/leaderboard stats.
    const mkVer = (this.db.prepare(`SELECT value FROM meta WHERE key = 'markout_model_version'`).get() as { value: string } | undefined)?.value;
    if (mkVer !== MARKOUT_MODEL_VERSION) {
      const nulls = JSON.stringify([null, null, null, null, null]);
      const info = this.db.prepare(`UPDATE fills SET markouts_bps = ? WHERE markouts_bps != ?`).run(nulls, nulls);
      if (Number(info.changes) > 0) console.log(`[mpamm] markout model → ${MARKOUT_MODEL_VERSION}: reset markouts on ${info.changes} retained fill(s)`);
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('markout_model_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(MARKOUT_MODEL_VERSION);
    }

    this.dayStmt = this.db.prepare(`
      INSERT INTO daily_volume (utc_day, venue_id, usd, swaps) VALUES (?, ?, ?, ?)
      ON CONFLICT(utc_day, venue_id) DO UPDATE SET usd = excluded.usd, swaps = excluded.swaps`);
    this.dayMetaStmt = this.db.prepare(`
      INSERT INTO day_meta (utc_day, partial) VALUES (?, ?)
      ON CONFLICT(utc_day) DO UPDATE SET partial = excluded.partial`);
    this.metaStmt = this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    this.fillStmt = this.db.prepare(`
      INSERT INTO fills (id, ts, block_number, venue_id, market, side, category, usd, base_amount, exec_px, tx_hash, to_label, pool, markouts_bps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET markouts_bps = excluded.markouts_bps`);
  }

  private runDay(d: DailyVolume): void {
    this.dayMetaStmt.run(d.utcDay, d.partial ? 1 : 0);
    for (const [venueId, vd] of Object.entries(d.byVenue)) this.dayStmt.run(d.utcDay, venueId, vd.usd, vd.swaps);
  }
  private runFill(f: Fill): void {
    this.fillStmt.run(f.id, f.ts, f.blockNumber, f.venueId, f.market, f.side, f.category,
      f.usd, f.baseAmount, f.execPx, f.txHash, f.to, f.pool, JSON.stringify(f.markoutsBps));
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value;
  }
  setMeta(key: string, value: string): void { this.metaStmt.run(key, value); }

  upsert(d: DailyVolume): void { this.runDay(d); }
  upsertMany(days: DailyVolume[]): void { for (const d of days) this.runDay(d); }

  /**
   * Prune rows whose venue_id is no longer in the registry (a venue was removed)
   * — non-destructive: every REMAINING venue's history is kept, unlike a schema
   * reset. Called once on boot. Guarded against an empty keep-set so a
   * misconfigured registry can never wipe the whole table.
   */
  reconcileVenues(keepIds: string[]): { volume: number; fills: number } {
    if (!keepIds.length) return { volume: 0, fills: 0 };
    const q = keepIds.map(() => '?').join(',');
    const v = this.db.prepare(`DELETE FROM daily_volume WHERE venue_id NOT IN (${q})`).run(...keepIds);
    const f = this.db.prepare(`DELETE FROM fills WHERE venue_id NOT IN (${q})`).run(...keepIds);
    return { volume: Number(v.changes), fills: Number(f.changes) };
  }

  /** Reconstruct DailyVolume[] from the long (day, venue) rows + partial flags. */
  all(): DailyVolume[] {
    const dayRows = this.db.prepare(`SELECT utc_day, venue_id, usd, swaps FROM daily_volume ORDER BY utc_day ASC`).all() as Array<Record<string, any>>;
    const metaRows = this.db.prepare(`SELECT utc_day, partial FROM day_meta`).all() as Array<Record<string, any>>;
    const partialByDay = new Map(metaRows.map((r) => [r.utc_day as string, !!r.partial]));
    const byDay = new Map<string, DailyVolume>();
    for (const r of dayRows) {
      let d = byDay.get(r.utc_day);
      if (!d) { d = { utcDay: r.utc_day, partial: partialByDay.get(r.utc_day) ?? false, byVenue: {} }; byDay.set(r.utc_day, d); }
      d.byVenue[r.venue_id] = { usd: r.usd, swaps: r.swaps };
    }
    // include a day that has only a partial flag (e.g. today before its first fill)
    for (const [day, partial] of partialByDay) if (!byDay.has(day)) byDay.set(day, { utcDay: day, partial, byVenue: {} });
    return [...byDay.values()].sort((a, b) => (a.utcDay < b.utcDay ? -1 : 1));
  }

  // ── fills ─────────────────────────────────────────────────────────────────
  /**
   * Atomic snapshot write: daily volume + the cursor meta + aged/new fills, all
   * in ONE transaction. This is the hot persist path — writing them together
   * means a crash can never leave the volume ahead of the lastProcessedBlock
   * cursor, which a gap-fill on the next boot would otherwise re-count (fills
   * dedupe by their deterministic txHash:logIndex id).
   */
  persistSnapshot(days: DailyVolume[], meta: Record<string, string>, fills: Fill[]): void {
    this.db.exec('BEGIN');
    try {
      for (const d of days) this.runDay(d);
      for (const [k, v] of Object.entries(meta)) this.metaStmt.run(k, v);
      for (const f of fills) this.runFill(f);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Insert/refresh fills (markouts mutate as a fill ages) in one transaction. */
  upsertFills(fills: Fill[]): void {
    if (!fills.length) return;
    this.db.exec('BEGIN');
    try {
      for (const f of fills) this.runFill(f);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Most recent fills, oldest-first (ready to use as an in-memory ring). */
  recentFills(limit: number): Fill[] {
    const rows = this.db.prepare(`SELECT * FROM fills ORDER BY ts DESC LIMIT ?`).all(limit) as Array<Record<string, any>>;
    return rows.map(rowToFill).reverse();
  }

  /** Fills since `sinceMs` (epoch ms), newest-first, capped at `limit`. */
  fillsSince(sinceMs: number, limit: number): Fill[] {
    const rows = this.db.prepare(`SELECT * FROM fills WHERE ts >= ? ORDER BY ts DESC LIMIT ?`).all(sinceMs, limit) as Array<Record<string, any>>;
    return rows.map(rowToFill);
  }

  /** Exact retained fill counts by UTC day and venue, with no API/query cap. */
  fillCountsByDayVenue(): Array<{ utcDay: string; venueId: string; swaps: number }> {
    const rows = this.db.prepare(`
      SELECT date(ts / 1000, 'unixepoch') AS utc_day, venue_id, COUNT(*) AS swaps
      FROM fills
      GROUP BY utc_day, venue_id
    `).all() as Array<Record<string, any>>;
    return rows.map((r) => ({ utcDay: r.utc_day, venueId: r.venue_id, swaps: Number(r.swaps) }));
  }

  /** Drop fills older than `beforeMs` (retention). Returns rows removed. */
  pruneFills(beforeMs: number): number {
    const info = this.db.prepare(`DELETE FROM fills WHERE ts < ?`).run(beforeMs);
    return Number(info.changes);
  }

  close(): void { this.db.close(); }
}

function rowToFill(r: Record<string, any>): Fill {
  return {
    id: r.id, ts: r.ts, blockNumber: r.block_number, venueId: r.venue_id,
    market: r.market, side: r.side, category: r.category,
    usd: r.usd, baseAmount: r.base_amount, execPx: r.exec_px,
    txHash: r.tx_hash, to: r.to_label, pool: r.pool,
    markoutsBps: JSON.parse(r.markouts_bps),
  };
}
