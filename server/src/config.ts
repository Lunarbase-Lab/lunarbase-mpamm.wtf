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
  // Production default: live (real Monad RPC + Bybit). Set DATA_SOURCE=sim to
  // run the fully offline deterministic simulator instead.
  source: (env.DATA_SOURCE?.toLowerCase() === 'sim' ? 'sim' : 'live') as SourcePref,

  rpcHttp: env.RPC_HTTP_URL ?? 'https://rpc.monad.xyz',
  rpcWs: env.RPC_WS_URL ?? 'wss://rpc.monad.xyz',

  bybitRest: env.BYBIT_REST_URL ?? 'https://api.bybit.com',
  bybitWs: env.BYBIT_WS_URL ?? 'wss://stream.bybit.com/v5/public/spot',
  bybitSymbol: env.BYBIT_SYMBOL ?? 'MONUSDT',

  takerBps: num('TAKER_BPS', 10),
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
  /** Decoded fills are persisted; rows older than this are pruned. The
   *  leaderboard's widest window is 30d, so keep a little more. */
  fillsRetentionDays: num('FILLS_RETENTION_DAYS', 35),

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
} as const;

export type Config = typeof config;
