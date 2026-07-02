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
  on(ev: 'message', cb: (m: StreamMessage) => void): this;
  off(ev: 'message', cb: (m: StreamMessage) => void): this;
}

export abstract class BaseSource extends EventEmitter implements DataSource {
  abstract readonly mode: DataSourceMode;
  abstract start(): Promise<void>;
  abstract stop(): void;
  abstract getState(): MarketState;
  abstract getQuotes(): QuoteSnapshot;
  abstract getFills(): Fill[];
  abstract getVolume(): DailyVolume[];

  /** Default: filter the in-memory window. Live overrides with a DB query. */
  queryFills(opts: { sinceMs?: number; limit?: number }): Fill[] {
    const sinceMs = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) && opts.sinceMs > 0 ? opts.sinceMs : undefined;
    const rawLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 1000;
    const limit = Math.min(Math.floor(rawLimit), 50_000);
    let fills = this.getFills();
    if (sinceMs != null) fills = fills.filter((f) => f.ts >= sinceMs);
    return [...fills].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  protected emitMsg(m: StreamMessage): void {
    this.emit('message', m);
  }
}
