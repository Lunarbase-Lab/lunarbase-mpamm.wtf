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

  protected emitMsg(m: StreamMessage): void {
    this.emit('message', m);
  }
}
