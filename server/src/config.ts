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
  /** Optional LFJ analytics key; without it, LFJ history grows forward only. */
  lfjApiKey: env.LFJ_API_KEY ?? '',
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
} as const;

export type Config = typeof config;
