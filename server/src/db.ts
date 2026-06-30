import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DailyVolume, Fill } from '@shared';

/**
 * SQLite persistence (spec §6.2). The DB is the source of truth for history:
 * daily-volume aggregates + the lastProcessedBlock cursor, and decoded fills
 * (the tape/markouts/leaderboard are expensive to re-derive — log decode + a
 * Bybit-mid join — so they're stored, not just held in a live window). The
 * current quote matrix stays in memory (replace-on-poll, cheap to refetch).
 */
export class VolumeStore {
  private db: DatabaseSync;

  constructor(path = 'data/mpamm.db') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_volume (
        utc_day      TEXT PRIMARY KEY,
        lfj          REAL NOT NULL DEFAULT 0,
        clober_venue REAL NOT NULL DEFAULT 0,
        clober_vault REAL NOT NULL DEFAULT 0,
        swaps        INTEGER NOT NULL DEFAULT 0,
        partial      INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS fills (
        id           TEXT PRIMARY KEY,
        ts           INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        protocol     TEXT NOT NULL,
        source       TEXT NOT NULL,
        scope        TEXT NOT NULL,
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
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  upsert(d: DailyVolume): void {
    this.db
      .prepare(`INSERT INTO daily_volume (utc_day, lfj, clober_venue, clober_vault, swaps, partial)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(utc_day) DO UPDATE SET
                  lfj=excluded.lfj, clober_venue=excluded.clober_venue,
                  clober_vault=excluded.clober_vault, swaps=excluded.swaps, partial=excluded.partial`)
      .run(d.utcDay, d.lfj, d.cloberVenue, d.cloberVault, d.swaps, d.partial ? 1 : 0);
  }

  upsertMany(days: DailyVolume[]): void {
    for (const d of days) this.upsert(d);
  }

  all(): DailyVolume[] {
    const rows = this.db.prepare(`SELECT * FROM daily_volume ORDER BY utc_day ASC`).all() as Array<Record<string, any>>;
    return rows.map((r) => ({
      utcDay: r.utc_day, lfj: r.lfj, cloberVenue: r.clober_venue,
      cloberVault: r.clober_vault, swaps: r.swaps, partial: !!r.partial,
    }));
  }

  // ── fills ─────────────────────────────────────────────────────────────────
  /** Insert/refresh fills (markouts mutate as a fill ages) in one transaction. */
  upsertFills(fills: Fill[]): void {
    if (!fills.length) return;
    const stmt = this.db.prepare(`
      INSERT INTO fills (id, ts, block_number, protocol, source, scope, market, side, category, usd, base_amount, exec_px, tx_hash, to_label, pool, markouts_bps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET markouts_bps = excluded.markouts_bps`);
    this.db.exec('BEGIN');
    try {
      for (const f of fills) {
        stmt.run(f.id, f.ts, f.blockNumber, f.protocol, f.source, f.scope, f.market, f.side, f.category,
          f.usd, f.baseAmount, f.execPx, f.txHash, f.to, f.pool, JSON.stringify(f.markoutsBps));
      }
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

  /** Drop fills older than `beforeMs` (retention). Returns rows removed. */
  pruneFills(beforeMs: number): number {
    const info = this.db.prepare(`DELETE FROM fills WHERE ts < ?`).run(beforeMs);
    return Number(info.changes);
  }

  close(): void { this.db.close(); }
}

function rowToFill(r: Record<string, any>): Fill {
  return {
    id: r.id, ts: r.ts, blockNumber: r.block_number,
    protocol: r.protocol, source: r.source, scope: r.scope, market: r.market, side: r.side, category: r.category,
    usd: r.usd, baseAmount: r.base_amount, execPx: r.exec_px,
    txHash: r.tx_hash, to: r.to_label, pool: r.pool,
    markoutsBps: JSON.parse(r.markouts_bps),
  };
}
