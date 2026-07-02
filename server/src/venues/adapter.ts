import type { PublicClient } from 'viem';
import type { Fill, QuoteRow, VenueMeta } from '@shared';
import type { getLogsChunked } from '../chain/rpc.js';
import type { UsdPricer } from '../pricer.js';
import type { Config } from '../config.js';

/**
 * Venue adapter contract — the composable unit.
 *
 * The core (indexer, aggregator, markouts, DB, API, frontend) is entirely
 * venue-agnostic: it only ever sees `VenueMeta` + `Fill.venueId` + `QuoteRow.venueId`.
 * A protocol is plugged in by dropping ONE adapter file here and adding it to
 * `registry.ts` — no core edits. An adapter can source its data fully on-chain,
 * from a subgraph, or a mix; it just has to return the shared shapes.
 *
 * See ADAPTERS.md for a walkthrough and `_template.ts` for a copy-paste stub.
 */

/** Shared infrastructure handed to every adapter — use these instead of importing
 *  the globals, so an adapter is a pure function of its context. */
export interface AdapterContext {
  /** viem public client for the Monad RPC (contract reads / multicall). */
  client: PublicClient;
  /** range-chunked getLogs (the public RPC caps eth_getLogs spans). */
  getLogs: typeof getLogsChunked;
  /** token→USD pricing (stables = $1, MON off the reference mid). */
  pricer: UsdPricer;
  config: Config;
  log: (m: string) => void;
  /** the CEX reference mid (MON/USD) — rarely needed; markouts are computed by the core. */
  referenceMid: () => number;
}

/** A group of on-chain logs the core fetches each cycle for this adapter and
 *  hands back to `decode()` under `key`. `events` are viem AbiEvent objects
 *  (e.g. `abi.filter(x => x.type === 'event' && x.name === 'Swap')`). */
export interface LogSource {
  key: string;
  address: `0x${string}` | `0x${string}`[];
  events: readonly unknown[];
  /** what this source feeds — governs how a fetch FAILURE is handled:
   *  - `'fills'`       (default): fill-producing. Failure HOLDS the block cursor
   *    — the whole tail cycle is skipped and re-tried next cycle, so no fills are
   *    lost or partially decoded.
   *  - `'state'`       : decoding state (e.g. pool/book `Open`s). Missing it can
   *    make later fills undecodable, so failure ALSO holds the cursor.
   *  - `'attribution'` : labels only (e.g. router tags). Failure is tolerated —
   *    the cursor advances and affected fills just carry degraded attribution. */
  kind?: 'fills' | 'state' | 'attribution';
}

/** Logs delivered to `decode()`, keyed by `LogSource.key`. */
export type LogBundle = Record<string, any[]>;

/** Optional historical seed returned by `backfill()`. */
export interface AdapterBackfill {
  /** closed-day per-venue volume to merge into the store (usd; swaps defaults to 0). */
  days?: Array<{ utcDay: string; byVenue: Record<string, { usd: number; swaps?: number }> }>;
  /** optional historical fills (for tape/markouts/leaderboard). */
  fills?: Fill[];
}

export interface VenueAdapter {
  /** the display venue(s) this adapter produces — usually one. Every `Fill`/`QuoteRow`
   *  it emits must carry a `venueId` that is one of these. */
  venues(): VenueMeta[];
  /** find the markets/pools this venue trades. The adapter holds its own state
   *  (markets, book cache, …). Called once at boot; may also be called to refresh. */
  discover(ctx: AdapterContext): Promise<void>;
  /** optional one-time historical seed (subgraph or on-chain backfill). */
  backfill?(ctx: AdapterContext, sinceUtc: string): Promise<AdapterBackfill>;
  /** optional live bid/ask per market×size for the Execution tab. */
  quote?(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]>;
  /** the contract logs the core should fetch each cycle (read after `discover`).
   *  If discovery is required to enumerate fill/state sources and is not ready,
   *  throw here so the core holds the cursor instead of tailing an incomplete
   *  source set. Returning [] means there are genuinely no logs to tail. */
  logSources(): LogSource[];
  /** decode this adapter's fetched logs into normalized fills. Owns any
   *  venue-specific correlation (router maps, mid-run pool discovery, filtering).
   *  `failedSources` holds the keys of any `'attribution'` sources whose fetch
   *  failed this cycle (required-source failures never reach decode — the cycle is
   *  skipped). Use it to avoid a confident label when attribution is unavailable
   *  (e.g. tag a fill `UNKNOWN` instead of `DIRECT`). If this method throws, the
   *  core holds the cursor and retries the whole range; catch and skip individual
   *  malformed/irrelevant logs locally. */
  decode(ctx: AdapterContext, logs: LogBundle, tsOf: (bn: bigint) => number, failedSources: Set<string>): Fill[] | Promise<Fill[]>;
}

/**
 * The CEX reference (Bybit) — the benchmark for markouts and the Execution
 * comparison, NOT a fill-producing venue. Exactly one is registered.
 */
export interface ReferenceAdapter {
  meta(): VenueMeta;
  start(): Promise<void>;
  stop(): void;
  monUsd(): number;
  mid(): number;
  changePct(): number;
  /** the CEX taker walk per market×size (the benchmark quote rows). */
  quote(ctx: AdapterContext, sizesUsd: readonly number[]): QuoteRow[];
}
