import { EventEmitter } from 'node:events';
import type {
  DataSourceMode, MarketState, QuoteSnapshot, Fill, DailyVolume, StreamMessage,
} from '@shared';

/**
 * A DataSource produces the entire dashboard data model and streams updates.
 * LiveDataSource builds it from Monad RPC + Bybit; SimDataSource simulates it.
 * The server and frontend are identical across both (spec D1).
 */
export interface DataSource {
  readonly mode: DataSourceMode;
  start(): Promise<void>;
  stop(): void;
  getState(): MarketState;
  getQuotes(): QuoteSnapshot;
  getFills(): Fill[];
  getVolume(): DailyVolume[];
  /** Historical fills query (DB-backed for live, in-memory for sim). */
  queryFills(opts: { sinceMs?: number; limit?: number }): Fill[];
  /** The last ~60s of REAL quote ticks for one (market, size) — seeds the
   *  Execution chart so it never fabricates history (flat pre-fill). */
  quoteHistory(market: string, size: number): QuoteSnapshot[];
  on(ev: 'message', cb: (m: StreamMessage) => void): this;
  off(ev: 'message', cb: (m: StreamMessage) => void): this;
}

/** Quote-history ring length — matches the frontend chart window (N=120 samples
 *  ≈ 60s at the 500ms poll cadence). ~40 rows/snapshot × 120 ≈ 5k rows in memory. */
const QUOTE_HISTORY_N = 120;

export abstract class BaseSource extends EventEmitter implements DataSource {
  abstract readonly mode: DataSourceMode;
  abstract start(): Promise<void>;
  abstract stop(): void;
  abstract getState(): MarketState;
  abstract getQuotes(): QuoteSnapshot;
  abstract getFills(): Fill[];
  abstract getVolume(): DailyVolume[];

  /** Rolling ring of the last QUOTE_HISTORY_N broadcast quote matrices — recorded
   *  at the emitMsg choke point so live + sim get it identically for free. */
  private quoteHist: QuoteSnapshot[] = [];

  /** Default: filter the in-memory window. Live overrides with a DB query. */
  queryFills(opts: { sinceMs?: number; limit?: number }): Fill[] {
    const sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) && opts.sinceMs > 0 ? opts.sinceMs : undefined;
    const rawLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 1000;
    const limit = Math.min(Math.floor(rawLimit), 50_000);
    let fills = this.getFills();
    if (sinceMs != null) fills = fills.filter((f) => f.ts >= sinceMs);
    return [...fills].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  /** The retained ticks filtered to one (market, size) — oldest first, ready to
   *  replay into the chart buffer. Empty until the first poll after boot. */
  quoteHistory(market: string, size: number): QuoteSnapshot[] {
    const out: QuoteSnapshot[] = [];
    for (const q of this.quoteHist) {
      const rows = q.rows.filter((r) => r.market === market && r.sizeUsd === size);
      if (rows.length) out.push({ block: q.block, monUsd: q.monUsd, ts: q.ts, rows });
    }
    return out;
  }

  protected emitMsg(m: StreamMessage): void {
    if (m.ch === 'quotes') {
      // live/sim both replace the matrix wholesale each poll (never mutate a
      // broadcast one), so retaining by reference is safe.
      this.quoteHist.push(m.data);
      if (this.quoteHist.length > QUOTE_HISTORY_N) this.quoteHist.shift();
    }
    this.emit('message', m);
  }
}
