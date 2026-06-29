import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DailyVolume } from '@shared';

/**
 * SQLite persistence for closed daily-volume buckets (spec §6.2). v1 storage is
 * a single-writer service with low cardinality. Live state stays in memory;
 * only DailyVolume is persisted so history survives restarts.
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
    `);
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

  close(): void { this.db.close(); }
}
