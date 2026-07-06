import { SIZES_USD, HISTORY_START_UTC } from '@shared';

const env = process.env;

function num(key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export type SourcePref = 'sim' | 'live';

export const config = {
  // API_PORT (not PORT) so the backend never collides with a dev-tool/preview
  // manager that injects PORT for the frontend.
  port: num('API_PORT', 8787),
  /** When set, serve the built frontend (web/dist) from this path same-origin
   *  (production single-service). Unset in dev — Vite serves the frontend. */
  webDist: env.WEB_DIST ?? '',
  // Production default: live (real Monad RPC + CEX references). Set DATA_SOURCE=sim to
  // run the fully offline deterministic simulator instead.
  source: (env.DATA_SOURCE?.toLowerCase() === 'sim' ? 'sim' : 'live') as SourcePref,

  rpcHttp: env.RPC_HTTP_URL ?? 'https://rpc.monad.xyz',
  rpcWs: env.RPC_WS_URL ?? 'wss://rpc.monad.xyz',

  bybitRest: env.BYBIT_REST_URL ?? 'https://api.bybit.com',
  bybitWs: env.BYBIT_WS_URL ?? 'wss://stream.bybit.com/v5/public/spot',
  bybitSymbol: env.BYBIT_SYMBOL ?? 'MONUSDT',

  // Binance spot — the CEX reference for non-MON assets (BTC/ETH); MON has no
  // Binance spot so it stays on Bybit. Symbols come from the asset registry.
  // Defaults are Binance's OFFICIAL public market-data mirror (binance.vision):
  // identical engine data + the same REST/WS interfaces, but NOT geo-blocked —
  // api.binance.com returns HTTP 451 from US IPs (e.g. Render Oregon), which
  // silently starved the BTC/ETH references in prod. We only consume public
  // market data, so the mirror is strictly the better default everywhere.
  binanceRest: env.BINANCE_REST_URL ?? 'https://data-api.binance.vision',
  binanceWs: env.BINANCE_WS_URL ?? 'wss://data-stream.binance.vision',

  /** Bybit taker fee (bps) for the MON benchmark — default Supreme VIP (4.5 bps),
   *  Bybit's top PUBLISHED spot tier: the advanced-trader benchmark, matching the
   *  Binance-VIP9 philosophy below (PRO/MM tiers go lower but aren't published). */
  takerBps: num('TAKER_BPS', 4.5),
  /** Binance taker fee (bps) for the BTC/ETH benchmark — default VIP9 (2.25 bps). */
  binanceTakerBps: num('BINANCE_TAKER_BPS', 2.25),
  quoteIntervalMs: num('QUOTE_INTERVAL_MS', 500),

  sizesUsd: [...SIZES_USD],

  /** getLogs range cap observed on the public RPC (413 above ~100 blocks). */
  getLogsChunk: num('GETLOGS_CHUNK', 90),

  // ── history (persist-forward indexer) ──────────────────────────────────────
  /** SQLite file — authoritative daily-volume history + lastProcessedBlock. */
  dbPath: env.DB_PATH ?? 'data/mpamm.db',
  /** Clober Goldsky subgraph — one-time seed of historical daily volume. */
  subgraphUrl: env.SUBGRAPH_URL ?? 'https://api.goldsky.com/api/public/project_clsljw95chutg01w45cio46j0/subgraphs/v2-subgraph-monad/latest/gn',
  /** First UTC day to seed history from. */
  seedSinceUtc: env.SEED_SINCE_UTC ?? HISTORY_START_UTC,
  /** Snapshot persistence cadence (ms). */
  persistMs: num('PERSIST_MS', 5000),
  /** Periodic re-discovery cadence (ms) — re-runs each adapter's discover() so
   *  mid-run/missed pool state self-heals from its authoritative source. */
  rediscoverMs: num('REDISCOVER_MS', 600_000),
  /** Max same-day gap to fill from getLogs on restart (else start at tip). */
  gapFillMaxBlocks: num('GAPFILL_MAX_BLOCKS', 200000),
  /** Decoded fills are persisted FOREVER by default (0 = no pruning): historical
   *  fills carry the venue-lifetime markouts, and ~1M rows ≈ a few hundred MB is
   *  fine on the persistent disk. Set a day count to re-enable pruning. */
  fillsRetentionDays: num('FILLS_RETENTION_DAYS', 0),
  /** The persisted per-pair mid curve keeps a fixed recent window regardless —
   *  it only exists to replay RECENT fills on a markout-model bump (historical
   *  markouts come from the CEX archives instead). */
  midsRetentionDays: num('MIDS_RETENTION_DAYS', 35),

  // ── on-chain backfill (background) ──────────────────────────────────────────
  /** Replay each opted-in adapter's Swap logs from its `backfillFromUtc` to seed
   *  deep daily-volume history without a subgraph. Runs in the background (never
   *  blocks boot or the live tail), resumes across restarts, self-heals per boot
   *  until complete. Set BACKFILL=off to disable (e.g. a range-limited RPC). */
  backfillEnabled: (env.BACKFILL ?? 'on').toLowerCase() !== 'off',
  /** Starting getLogs span for backfill — auto-shrinks on an RPC range error and
   *  floors at getLogsChunk, so it runs as wide as the node allows without 413s. */
  backfillChunk: num('BACKFILL_CHUNK', 800),
  /** Delay between backfill chunks (ms) — paces requests under the RPC rate cap. */
  backfillPaceMs: num('BACKFILL_PACE_MS', 40),
  /** Merge + persist backfilled volume (and advance the resume cursor) every N chunks. */
  backfillMergeEvery: num('BACKFILL_MERGE_EVERY', 50),
  /** Historical (venue-lifetime) markouts: after the on-chain backfill, mark
   *  every persisted historical fill against the exchanges' ARCHIVED prices
   *  (Bybit trade dumps at 1s, Binance 1s klines; crosses at 1m). Runs in the
   *  background, day-cursor per market, resumable. MARKOUT_BACKFILL=off disables. */
  markoutBackfill: (env.MARKOUT_BACKFILL ?? 'on').toLowerCase() !== 'off',
  /** ONE-SHOT full re-scan trigger: comma-separated venue ids (e.g. "metric").
   *  On boot, clears those venues' backfill done-flag + cursor so their history
   *  re-scans from backfillFromUtc — use after switching to a better archive RPC
   *  to recover skipped holes. Applied once per VALUE (a marker meta remembers
   *  it), so redeploys don't re-trigger; to re-run again later, change the value
   *  (e.g. "metric@2"). The SET-per-day merge keeps re-scans idempotent. */
  backfillReset: env.BACKFILL_RESET ?? '',
} as const;

export type Config = typeof config;
