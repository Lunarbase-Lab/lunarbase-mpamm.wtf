import type { QuoteRow, Fill, Side, FillCategory } from '@shared';
import { ADDR, TOKENS, isMonAddress, isMonSymbol } from '@shared';
import { publicClient, getLogsChunked } from '../chain/rpc.js';
import { bookViewerAbi, bookManagerAbi, liquidityVaultAbi, CLOBER_MIN_PRICE } from '../chain/abis.js';
import { fromUnits, toUnits, nextId, shortHex } from '../util.js';
import type { UsdPricer } from '../pricer.js';

/**
 * Clober V2 — best-effort live integration (spec §3, §5.1, §5.2).
 *
 * A Clober "market" (MON/stable) is a pair of one-directional books; quoting
 * targets the book whose base == the input token. Deep discovery from the
 * deploy block is impractical on the public RPC (getLogs is range-capped), so
 * this scans recent Open logs to build a book cache + vault-bookId set; if that
 * yields nothing, Clober rows are simply absent and the matrix degrades to
 * LFJ + Bybit (allowFailure, spec §8).
 */

const ZERO = '0x0000000000000000000000000000000000000000';
/** Round-trip spread (bps) above which a Clober book is treated as not a real
 *  executable market (stale/dormant) and excluded from the exec comparison. */
const MAX_QUOTE_SPREAD_BPS = 1000;

export interface CloberBook {
  bookId: bigint;
  base: string;   // token address (lower)
  quote: string;
  unitSize: bigint;
  baseSym?: string;
  quoteSym?: string;
  isVault: boolean;
}

export interface CloberMarket {
  market: string;         // 'MON/USDC'
  stable: string;
  /** book with base = MON (quote = stable) — used to quote SELL MON. */
  monBase?: CloberBook;
  /** book with base = stable (quote = MON) — used to quote BUY MON. */
  stableBase?: CloberBook;
}

const tokenBySym = (sym: string) => TOKENS[sym];
const symByAddr = (addr: string): string | undefined =>
  Object.values(TOKENS).find((t) => t.address.toLowerCase() === addr.toLowerCase())?.symbol;

/** Assemble MON/stable markets from a book cache, preferring the vault book per
 *  direction so venue attribution + quoting are consistent across every
 *  discovery path and live merge. */
export function assembleCloberMarkets(books: Map<string, CloberBook>): CloberMarket[] {
  const markets: CloberMarket[] = [];
  for (const t of Object.values(TOKENS).filter((x) => x.stable)) {
    const st = t.address.toLowerCase();
    let monBase: CloberBook | undefined, stableBase: CloberBook | undefined;
    for (const b of books.values()) {
      if (isMonAddress(b.base) && b.quote === st && (!monBase || (b.isVault && !monBase.isVault))) monBase = b;
      if (b.base === st && isMonAddress(b.quote) && (!stableBase || (b.isVault && !stableBase.isVault))) stableBase = b;
    }
    if (monBase || stableBase) markets.push({ market: `MON/${t.symbol}`, stable: t.symbol, monBase, stableBase });
  }
  return markets;
}

/** Build a MON/stable CloberBook from an Open event's args; null if not MON/stable. */
export function cloberBookFromOpen(a: any, vault: Set<string>): CloberBook | null {
  const base = String(a.base).toLowerCase(), quote = String(a.quote).toLowerCase();
  if (isMonAddress(base) === isMonAddress(quote)) return null;
  const id = String(a.id);
  return {
    bookId: BigInt(a.id), base, quote, unitSize: BigInt(a.unitSize),
    baseSym: symByAddr(base), quoteSym: symByAddr(quote), isVault: vault.has(id),
  };
}

/** Build a book cache + vault set from recent Open logs, then assemble the
 *  MON/stable markets we can quote. `lookback` blocks back from head. */
export async function discoverClober(lookback = 4000): Promise<{ books: Map<string, CloberBook>; markets: CloberMarket[]; vault: Set<string> }> {
  const head = await publicClient.getBlockNumber();
  const from = head > BigInt(lookback) ? head - BigInt(lookback) : 0n;
  const books = new Map<string, CloberBook>();
  const vault = new Set<string>();

  try {
    const vlogs = (await getLogsChunked({
      address: ADDR.liquidityVault as `0x${string}`, fromBlock: from, toBlock: head,
      events: liquidityVaultAbi.filter((x: any) => x.type === 'event'),
    })) as any[];
    for (const l of vlogs) {
      if (l.args?.bookIdA !== undefined) vault.add(String(l.args.bookIdA));
      if (l.args?.bookIdB !== undefined) vault.add(String(l.args.bookIdB));
    }
  } catch { /* tolerate */ }

  try {
    const opens = (await getLogsChunked({
      address: ADDR.bookManager as `0x${string}`, fromBlock: from, toBlock: head,
      events: bookManagerAbi.filter((x: any) => x.type === 'event' && x.name === 'Open'),
    })) as any[];
    for (const l of opens) {
      const a = l.args; if (!a) continue;
      const base = String(a.base).toLowerCase(), quote = String(a.quote).toLowerCase();
      // keep exactly MON/stable books — else arbitrary Takes get mispriced as
      // MON/USDC volume when this fallback feeds decodeCloberTake (audit C1).
      if (isMonAddress(base) === isMonAddress(quote)) continue;
      const id = String(a.id);
      books.set(id, {
        bookId: BigInt(a.id), base, quote,
        unitSize: BigInt(a.unitSize), baseSym: symByAddr(base), quoteSym: symByAddr(quote),
        isVault: vault.has(id),
      });
    }
  } catch { /* tolerate */ }

  return { books, markets: assembleCloberMarkets(books), vault };
}

/**
 * Discover Clober books from the subgraph (spec Appendix B) — the public RPC
 * can't enumerate them (BookManager is a V4-style singleton, books are hashed
 * BookIds with no list view) and its getLogs is range-capped. The subgraph is
 * used ONLY for discovery: it yields each MON/stable book's id + base/quote +
 * unitSize, and `Book.pool != null` marks vault (propAMM) books. Live quotes
 * and fills then hit the chain (getExpectedOutput / Take logs) as usual.
 */
export async function discoverCloberViaSubgraph(
  url: string,
): Promise<{ books: Map<string, CloberBook>; markets: CloberMarket[]; vault: Set<string> }> {
  const addrs = Object.values(TOKENS).map((t) => `"${t.address.toLowerCase()}"`).join(',');
  const query = `{ books(first: 500, where: { base_in: [${addrs}], quote_in: [${addrs}] }) { id unitSize base { id } quote { id } pool { id } } }`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`subgraph ${res.status}`);
  const j: any = await res.json();
  const rows: Array<{ id: string; unitSize: string; base: { id: string }; quote: { id: string }; pool: { id: string } | null }> = j?.data?.books ?? [];

  const books = new Map<string, CloberBook>();
  const vault = new Set<string>();
  for (const r of rows) {
    const base = String(r.base.id).toLowerCase();
    const quote = String(r.quote.id).toLowerCase();
    // keep exactly MON/stable: one side MON (WMON or native), the other a stable
    if (isMonAddress(base) === isMonAddress(quote)) continue;
    const id = String(BigInt(r.id));
    const isVault = !!r.pool;
    if (isVault) vault.add(id);
    books.set(id, {
      bookId: BigInt(r.id), base, quote, unitSize: BigInt(r.unitSize),
      baseSym: symByAddr(base), quoteSym: symByAddr(quote), isVault,
    });
  }

  return { books, markets: assembleCloberMarkets(books), vault };
}

/** Quote Clober for each market × size via BookViewer.getExpectedOutput. */
export async function quoteClober(
  markets: CloberMarket[], sizesUsd: readonly number[], monUsd: number, pricer: UsdPricer,
): Promise<QuoteRow[]> {
  if (!markets.length || monUsd <= 0) return [];
  type Leg = { market: string; size: number; side: Side; book: CloberBook; inDec: number; outDec: number; venue: 'Clober' | 'Vault'; reqBase: bigint };
  const legs: Leg[] = [];
  for (const m of markets) {
    const stable = tokenBySym(m.stable);
    // venue is decided per market (not per leg) so a market's bid + ask land in
    // the same row; a market backed by vault books surfaces as the Vault venue.
    const venue: 'Clober' | 'Vault' = (m.monBase?.isVault || m.stableBase?.isVault) ? 'Vault' : 'Clober';
    for (const size of sizesUsd) {
      if (m.monBase) {
        // SELL MON: spend base(MON) → take quote(stable)
        legs.push({ market: m.market, size, side: 'sell', book: m.monBase, inDec: TOKENS.WMON.decimals, outDec: stable.decimals, venue, reqBase: toUnits(pricer.tokenForUsd('WMON', size), TOKENS.WMON.decimals) });
      }
      if (m.stableBase) {
        // BUY MON: spend base(stable) → take quote(MON)
        legs.push({ market: m.market, size, side: 'buy', book: m.stableBase, inDec: stable.decimals, outDec: TOKENS.WMON.decimals, venue, reqBase: toUnits(size, stable.decimals) });
      }
    }
  }
  if (!legs.length) return [];

  const contracts = legs.map((l) => ({
    address: ADDR.bookViewer as `0x${string}`,
    abi: bookViewerAbi,
    functionName: 'getExpectedOutput' as const,
    args: [{ id: l.book.bookId, limitPrice: CLOBER_MIN_PRICE, baseAmount: l.reqBase, minQuoteAmount: 0n, hookData: '0x' as `0x${string}` }] as const,
  }));
  const res = await publicClient.multicall({ contracts, allowFailure: true });

  const rowByKey = new Map<string, QuoteRow>();
  const ts = Date.now();
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i]; const r = res[i];
    if (r.status !== 'success') continue;
    const [takenQuote, spentBase] = r.result as readonly [bigint, bigint];
    if (takenQuote <= 0n || spentBase <= 0n) continue;
    const takenH = fromUnits(takenQuote, l.outDec);
    const spentH = fromUnits(spentBase, l.inDec);
    // px = stable per MON. The px is over the FILLED portion only; flag when the
    // book exhausts before the requested size so it doesn't read as tight (B3).
    const px = l.side === 'sell' ? takenH / spentH : spentH / takenH;
    const bps = (px / monUsd - 1) * 1e4;
    const legFilledFull = spentBase >= (l.reqBase * 999_999_999n) / 1_000_000_000n;
    const venue = l.venue;
    const key = `${venue}|${l.market}|${l.size}`;
    let row = rowByKey.get(key);
    if (!row) {
      row = { venue, market: l.market, sizeUsd: l.size, bidBps: 0, askBps: 0, bidPx: 0, askPx: 0, spreadBps: 0, filledFull: true, feeBps: 0, ts };
      rowByKey.set(key, row);
    }
    row.filledFull &&= legFilledFull;
    if (l.side === 'buy') { row.askBps = bps; row.askPx = px; } else { row.bidBps = bps; row.bidPx = px; }
  }
  for (const row of rowByKey.values()) row.spreadBps = row.askBps - row.bidBps;
  // Exclude non-executable books from the exec comparison: a book whose round-
  // trip spread is absurd (a stale/dormant vault resting orders at far ticks —
  // e.g. ask 2.5× / bid 0.09× mid) has no real two-sided liquidity to compare.
  // Its historical activity still shows in the Volume tab.
  return [...rowByKey.values()].filter((r) => r.askPx > 0 && r.bidPx > 0 && r.spreadBps < MAX_QUOTE_SPREAD_BPS);
}

/** routed-flow attribution for a Take (its tx also emitted a RouterGateway.Swap). */
export interface RouterInfo { to: string; category: FillCategory; }

/**
 * Clober V2 tick → realized price, stable-per-MON. The protocol price is
 * 1.0001^tick = quote-raw per base-raw (verified against MIN_PRICE 1350587 at
 * MIN_TICK and the live BookDayData/Take prices). Converting raw→human and
 * orienting to stable-per-MON: 1.0001^(±tick) × 10^(18 − stableDecimals), with
 * the sign + when MON is the book's base, − when MON is the quote.
 */
export function cloberTickToPrice(tick: number, monIsBase: boolean, stableDecimals: number): number {
  return Math.pow(1.0001, monIsBase ? tick : -tick) * Math.pow(10, 18 - stableDecimals);
}

/**
 * Decode a Clober Take into a Fill (spec §5.2). The quote leg is exact
 * (unit × unitSize); the realized price + base leg come from the resting tick,
 * so the fill carries a true execution price and real markouts (audit B1-real).
 * `tsMs` is the block timestamp (audit B2); `router` tags routed flow (audit I3).
 */
export function decodeCloberTake(
  log: { args: any; transactionHash: string; blockNumber: bigint },
  books: Map<string, CloberBook>, vault: Set<string>, tsMs: number, router?: RouterInfo,
): Fill | null {
  const a = log.args; if (!a) return null;
  const bookId = String(a.bookId);
  const book = books.get(bookId);
  if (!book) return null;
  const { baseSym, quoteSym } = book;

  // require exactly MON/stable (one MON side, a real stable on the other) so a
  // mis-scoped book never gets booked as MON/USDC volume (audit C1).
  if (isMonSymbol(baseSym) === isMonSymbol(quoteSym)) return null;
  const monIsBase = isMonSymbol(baseSym);
  const stableSym = monIsBase ? quoteSym : baseSym;
  if (!stableSym || !TOKENS[stableSym]?.stable) return null;
  const stableDec = TOKENS[stableSym].decimals;

  // quote leg is exact (unit × unitSize); quote token = stable iff MON is base.
  const quoteDec = monIsBase ? stableDec : TOKENS.WMON.decimals;
  const quoteHuman = fromUnits(BigInt(a.unit) * book.unitSize, quoteDec);
  if (quoteHuman <= 0) return null;

  const execPx = cloberTickToPrice(Number(a.tick), monIsBase, stableDec);
  if (!Number.isFinite(execPx) || execPx <= 0) return null;

  // USD = the stable leg: exact when MON is base (quote IS the stable); else
  // derive the stable value from the realized price. No CEX mid needed (audit C3).
  const usd = monIsBase ? quoteHuman : quoteHuman * execPx;
  const baseAmount = usd / execPx; // MON amount
  if (usd <= 0) return null;

  // A Clober book is one-directional: a Take consumes resting bids (the taker
  // delivers base, receives quote), so side follows the book's orientation.
  const side: Side = monIsBase ? 'sell' : 'buy';
  const isVault = vault.has(bookId);

  return {
    id: nextId('clb'),
    protocol: 'Clober', source: 'clober-take', scope: isVault ? 'vault' : 'venue',
    market: `MON/${stableSym}`, side, category: router?.category ?? 'DIRECT',
    usd, baseAmount, execPx,
    txHash: log.transactionHash, to: router?.to ?? shortHex(a.user ?? ZERO),
    pool: `book ${bookId.slice(0, 8)}`,
    blockNumber: Number(log.blockNumber), ts: tsMs,
    markoutsBps: [null, null, null, null, null],
  };
}

/** Map txHash → routed-flow attribution from RouterGateway.Swap logs (audit I3).
 *  A routed swap also emits the underlying Take(s); we use it only to classify
 *  those Takes (category/to), never as a separate fill, so volume isn't doubled. */
export function buildRouterMap(logs: Array<{ args: any; transactionHash: string }>): Map<string, RouterInfo> {
  const m = new Map<string, RouterInfo>();
  for (const l of logs) {
    const a = l.args; if (!a) continue;
    m.set(l.transactionHash.toLowerCase(), { to: shortHex(String(a.router ?? ZERO)), category: 'ROUTER' });
  }
  return m;
}
