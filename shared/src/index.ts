/**
 * @mpamm/shared — the contract between the backend service and the frontend.
 *
 * Everything the frontend renders flows through these types (spec §6, D1). The
 * backend produces them from either real chain/Bybit data (LiveDataSource) or
 * the simulator (SimDataSource); the frontend never knows which.
 */

// ──────────────────────────────────────────────────────────────────────────
// Domain vocabulary
// ──────────────────────────────────────────────────────────────────────────

/** buy/sell of the base asset (MON). */
export type Side = 'buy' | 'sell';

/** Routing classification for a fill, shown in the tape/leaderboard. */
export type FillCategory = 'DIRECT' | 'ROUTER' | 'AGG' | 'CEX/DEX';

export type DataSourceMode = 'live' | 'sim';

/**
 * Venue identity — the composable unit. Every venue (LFJ, Clober Vault, …) and
 * the CEX reference (Bybit) is described by one of these, produced by its
 * adapter on the backend and shipped to the frontend so NOTHING about a venue
 * is hardcoded in the core: name, color and grouping all come from here.
 *
 * `role: 'venue'` = a propAMM/on-chain venue that lands fills and shows in
 * Volume/Markouts/Leaderboard. `role: 'reference'` = the CEX benchmark (Bybit):
 * it provides the markout/quote reference and shows only in Execution.
 */
export interface VenueMeta {
  /** stable key used everywhere as `Fill.venueId` / `QuoteRow.venueId` (e.g. 'lfj', 'clober-vault', 'bybit'). */
  id: string;
  /** display name (e.g. 'LFJ', 'Clober Vault', 'Bybit'). */
  name: string;
  /** venue color per theme — the single source of truth for line/bar/swatch color. */
  color: { light: string; dark: string };
  kind: 'amm' | 'clob' | 'vault' | 'cex';
  role: 'venue' | 'reference';
  /** reference venues that are walked as a taker render a "(taker)" suffix. */
  taker?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Constants — verified contracts & token universe (spec Appendix A)
// ──────────────────────────────────────────────────────────────────────────

export const MONAD_CHAIN_ID = 143;

/** UTC day this dashboard's history begins (spec: "since 2026-05-13"). */
export const HISTORY_START_UTC = '2026-05-13';

export const ADDR = {
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  // LFJ Liquidity Book v2.2
  lbFactory: '0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c',
  lbRouter: '0x18556DA13313f3532c54711497A8FedAC273220E',
  // Clober V2
  bookManager: '0x6657d192273731C3cAc646cc82D5F28D0CBE8CCC',
  bookViewer: '0xe424c211e2Ed8a5B6d1C57FA493C41715568D238',
  controller: '0x19b68a2b909D96c05B623050C276FBD457De8e83',
  routerGateway: '0x7B58A24C5628881a141D630f101Db433D419B372',
  liquidityVault: '0xB09684f5486d1af80699BbC27f14dd5A905da873',
  simpleOracleStrategy: '0x54cd5332b1689b6506Ce089DA5651B1A814e9E7D',
  operator: '0xCBd3C0B81A9a36356a3669A7f60A0d2F0846195B',
} as const;

/** Clober BookManager deploy block — start of on-chain history. */
export const CLOBER_DEPLOY_BLOCK = 31662843n;

export interface TokenInfo {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** USD stablecoin pegged to $1 (spec §5.5). */
  stable: boolean;
}

/**
 * MON has two on-chain representations and venues differ (spec §8, §9.4):
 *  - LFJ (ERC-20 AMM) pairs use the WMON wrapper.
 *  - Clober (V4-style) books + the LiquidityVault use NATIVE MON (the zero
 *    address, via isNative()).
 * Both are the same asset (same price, 18 decimals). Treat them as MON.
 */
export const NATIVE_MON = '0x0000000000000000000000000000000000000000';
export const WMON_ADDRESS = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a';

export const TOKENS: Record<string, TokenInfo> = {
  USDC: { symbol: 'USDC', address: '0x754704bc059f8c67012fed69bc8a327a5aafb603', decimals: 6, stable: true },
  USDT0: { symbol: 'USDT0', address: '0xe7cd86e13ac4309349f30b3435a9d337750fc82d', decimals: 6, stable: true },
  AUSD: { symbol: 'AUSD', address: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a', decimals: 6, stable: true },
  USD1: { symbol: 'USD1', address: '0x111111d2bf19e43c34263401e0cad979ed1cdb61', decimals: 18, stable: true },
  WMON: { symbol: 'WMON', address: WMON_ADDRESS, decimals: 18, stable: false },
  MON: { symbol: 'MON', address: NATIVE_MON, decimals: 18, stable: false },
};

/** A set of every token address that denotes MON (WMON wrapper + native MON). */
export const MON_ADDRESSES: ReadonlySet<string> = new Set([WMON_ADDRESS.toLowerCase(), NATIVE_MON]);

/** True if `addr` denotes MON in either representation. */
export function isMonAddress(addr: string): boolean {
  return MON_ADDRESSES.has(addr.toLowerCase());
}

/** True if a token symbol denotes MON (WMON or native MON). */
export function isMonSymbol(sym: string | undefined): boolean {
  return sym === 'WMON' || sym === 'MON';
}

/** v1 pair universe — MON vs USD stables (spec D5). */
export const MARKETS = ['MON/USDC', 'MON/USDT0', 'MON/AUSD', 'MON/USD1'] as const;
export type Market = (typeof MARKETS)[number];

/** Notional sizes (USD) probed per pair×side in the exec matrix. */
export const SIZES_USD = [100, 1000, 10000, 100000] as const;

/** Markout horizons (seconds) joined to the Bybit reference (spec §4.2/4.3). */
export const MARKOUT_HORIZONS = [0, 5, 10, 30, 60] as const;

// ──────────────────────────────────────────────────────────────────────────
// Quotes (Execution view, spec §4.2 / §6.1)
// ──────────────────────────────────────────────────────────────────────────

/** One realized quote for (venue, market, size). bid/ask are in bps vs the
 *  Bybit MONUSDT BBO mid; px is quote-per-base (stable per MON). */
export interface QuoteRow {
  /** which venue this quote belongs to (VenueMeta.id). */
  venueId: string;
  market: string;
  sizeUsd: number;
  bidBps: number;
  askBps: number;
  bidPx: number;
  askPx: number;
  /** ask − bid, the round-trip spread in bps. */
  spreadBps: number;
  /** false when the venue's liquidity exhausts before the full notional. */
  filledFull: boolean;
  /** true when only ONE side is executable at this size (the other side is thin /
   *  far-tick backstop): the shown side is real, the missing side is px 0 and
   *  spreadBps is not meaningful. Set by the Clober/Vault quoter (CLOB books that
   *  quote a genuine ask but no real bid at the requested size, or vice-versa). */
  oneSided?: boolean;
  /** venue fee in bps (LFJ getSwapOut fee); 0 for CLOB venues. */
  feeBps: number;
  /** realized cost vs Bybit-AS-TAKER at this size, sign-normalized so positive
   *  = on-chain executes worse (spec §4.2): cexAskBps for buying MON, cexBidBps
   *  for selling. The honest realized-vs-realized comparison. Undefined for the
   *  Bybit benchmark row itself. */
  cexAskBps?: number;
  cexBidBps?: number;
  ts: number;
}

/** The full quote matrix for one poll — replaced wholesale each tick. */
export interface QuoteSnapshot {
  block: number;
  monUsd: number;
  ts: number;
  rows: QuoteRow[];
}

// ──────────────────────────────────────────────────────────────────────────
// Fills (Tape, Markouts, Leaderboard — spec §4.3 / §6.1)
// ──────────────────────────────────────────────────────────────────────────

export interface Fill {
  id: string;
  /** which venue landed this fill (VenueMeta.id) — set by the venue's adapter. */
  venueId: string;
  market: string;
  side: Side;
  category: FillCategory;
  /** USD value of the stable quote leg (exact for MON/stable pairs). */
  usd: number;
  /** base (MON) amount of the fill. */
  baseAmount: number;
  /** realized execution price, quote-per-base. */
  execPx: number;
  /** true when execPx/baseAmount are NOT a realized price (e.g. Clober's base
   *  leg needs the deferred tick→price; spec §5.2). Such fills carry exact USD
   *  but no fill-quality markouts — consumers must not treat their markouts as
   *  real execution edge. */
  pxApprox?: boolean;
  txHash: string;
  /** human label for the `to`/router address. */
  to: string;
  /** pool/book label. */
  pool: string;
  blockNumber: number;
  ts: number;
  /** markout in bps vs Bybit reference at [0,5,10,30,60]s; null until aged. */
  markoutsBps: (number | null)[];
}

// ──────────────────────────────────────────────────────────────────────────
// Volume (spec §4.1 / §6.2)
// ──────────────────────────────────────────────────────────────────────────

/** One venue's slice of a day: USD notional + forward-indexed swap count.
 *  Seeded (backfilled) days may carry `usd` with `swaps: 0` when the source
 *  (e.g. a subgraph) exposes volume but not a per-swap count. */
export interface VenueDaily {
  usd: number;
  swaps: number;
}

export interface DailyVolume {
  /** UTC day, 'YYYY-MM-DD'. */
  utcDay: string;
  /** per-venue slice, keyed by VenueMeta.id. Venues absent from a day are 0. */
  byVenue: Record<string, VenueDaily>;
  /** true for today's still-accumulating bucket. */
  partial: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Market state / service status
// ──────────────────────────────────────────────────────────────────────────

export interface MarketState {
  chainId: number;
  block: number;
  monUsd: number;
  monChangePct: number;
  takerBps: number;
  markets: string[];
  sizesUsd: number[];
  quoteCadenceMs: number;
  source: DataSourceMode;
  /** the venue registry (adapters + CEX reference) — the frontend renders
   *  everything venue-related from this, so venues aren't hardcoded client-side. */
  venues: VenueMeta[];
  /** present when the live source degrades and parts fall back. */
  notes?: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// REST payloads + WS stream protocol
// ──────────────────────────────────────────────────────────────────────────

export interface MarketsResponse {
  state: MarketState;
  quotes: QuoteSnapshot;
  fills: Fill[];
  volume: DailyVolume[];
}

export type StreamMessage =
  | { ch: 'state'; data: MarketState }
  | { ch: 'quotes'; data: QuoteSnapshot }
  | { ch: 'fill'; data: Fill }
  | { ch: 'volume'; data: DailyVolume };

export const STREAM_PATH = '/stream';
