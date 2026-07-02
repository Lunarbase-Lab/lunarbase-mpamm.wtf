import type { QuoteRow, Fill, Side, FillCategory, VenueMeta } from '@shared';
import { ADDR, TOKENS, isMonAddress, isMonSymbol } from '@shared';
import { publicClient, getLogsChunked } from '../chain/rpc.js';
import { bookViewerAbi, bookManagerAbi, liquidityVaultAbi, routerGatewayAbi, CLOBER_MIN_PRICE } from '../chain/abis.js';
import { fromUnits, toUnits, shortHex } from '../util.js';
import type { UsdPricer } from '../pricer.js';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';
import { seedCloberDaily } from '../seed/subgraph.js';

/** Clober oracle-vault (propAMM) display venue — the ONE venue this adapter
 *  surfaces. Its per-theme color is the single source of truth for the frontend. */
const CLOBER_VAULT_VENUE: VenueMeta = { id: 'clober-vault', name: 'Clober Vault', color: { light: '#9C6B16', dark: '#9A88FF' }, kind: 'vault', role: 'venue' };

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
/** Per-side sanity band (bps from the Bybit mid): a quote side priced beyond
 *  ±this is a far-tick backstop / mispriced resting order, not executable
 *  liquidity. Verified on-chain against live Clober vault books — a real ask
 *  ≈ +70bps sits next to a backstop bid ≈ −7786bps and garbage asks in the
 *  thousands–billions of bps; ±20% cleanly separates the real side from those. */
const PER_SIDE_BAND_BPS = 2000;

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
  type Leg = { market: string; size: number; side: Side; book: CloberBook; inDec: number; outDec: number; reqBase: bigint };
  const legs: Leg[] = [];
  for (const m of markets) {
    const stable = tokenBySym(m.stable);
    for (const size of sizesUsd) {
      if (m.monBase) {
        // SELL MON: spend base(MON) → take quote(stable)
        legs.push({ market: m.market, size, side: 'sell', book: m.monBase, inDec: TOKENS.WMON.decimals, outDec: stable.decimals, reqBase: toUnits(pricer.tokenForUsd('WMON', size), TOKENS.WMON.decimals) });
      }
      if (m.stableBase) {
        // BUY MON: spend base(stable) → take quote(MON)
        legs.push({ market: m.market, size, side: 'buy', book: m.stableBase, inDec: stable.decimals, outDec: TOKENS.WMON.decimals, reqBase: toUnits(size, stable.decimals) });
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
  const fullByKey = new Map<string, { bid: boolean; ask: boolean }>();
  const ts = Date.now();
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i]; const r = res[i];
    if (r.status !== 'success') continue;
    const [takenQuote, spentBase] = r.result as readonly [bigint, bigint];
    if (takenQuote <= 0n || spentBase <= 0n) continue;
    const takenH = fromUnits(takenQuote, l.outDec);
    const spentH = fromUnits(spentBase, l.inDec);
    // px = stable per MON, over the FILLED portion only. limitPrice = MIN, so a
    // thin book sweeps to far ticks and the average price craters — the per-side
    // sanity check below catches that (and partial fills via filledFull, B3).
    const px = l.side === 'sell' ? takenH / spentH : spentH / takenH;
    const bps = (px / monUsd - 1) * 1e4;
    const legFilledFull = spentBase >= (l.reqBase * 999_999_999n) / 1_000_000_000n;
    const key = `${l.market}|${l.size}`;
    let row = rowByKey.get(key);
    if (!row) {
      row = { venueId: CLOBER_VAULT_VENUE.id, market: l.market, sizeUsd: l.size, bidBps: 0, askBps: 0, bidPx: 0, askPx: 0, spreadBps: 0, filledFull: true, feeBps: 0, ts };
      rowByKey.set(key, row);
      fullByKey.set(key, { bid: false, ask: false });
    }
    const fk = fullByKey.get(key)!;
    if (l.side === 'buy') { row.askBps = bps; row.askPx = px; fk.ask = legFilledFull; }
    else { row.bidBps = bps; row.bidPx = px; fk.bid = legFilledFull; }
  }

  // A side is executable at this size only if it fills the full notional AND
  // prices within ±PER_SIDE_BAND_BPS of mid. Both sides real → a clean two-sided
  // row; exactly one real → a one-sided row (the thin side zeroed, flagged) so a
  // genuine ask/bid still surfaces even when the book has no real other side;
  // neither → an empty/all-garbage book, dropped (activity still shows in Volume).
  const out: QuoteRow[] = [];
  for (const [key, row] of rowByKey) {
    const fk = fullByKey.get(key)!;
    row.spreadBps = row.askBps - row.bidBps;
    const bidReal = row.bidPx > 0 && fk.bid && Math.abs(row.bidBps) <= PER_SIDE_BAND_BPS;
    const askReal = row.askPx > 0 && fk.ask && Math.abs(row.askBps) <= PER_SIDE_BAND_BPS;
    if (bidReal && askReal) {
      row.oneSided = false;
      row.filledFull = fk.bid && fk.ask;
      out.push(row);
    } else if (bidReal !== askReal) {
      row.oneSided = true;
      row.filledFull = bidReal ? fk.bid : fk.ask;
      if (!bidReal) { row.bidPx = 0; row.bidBps = 0; }
      if (!askReal) { row.askPx = 0; row.askBps = 0; }
      row.spreadBps = 0; // not meaningful for a one-sided quote
      out.push(row);
    }
  }
  return out;
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
  log: { args: any; transactionHash: string; blockNumber: bigint; logIndex: number },
  books: Map<string, CloberBook>, tsMs: number, router?: RouterInfo,
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

  return {
    // deterministic id (txHash:logIndex) so re-tail/gap-fill/restart dedupes.
    id: `clb-${log.transactionHash.toLowerCase()}-${log.logIndex}`,
    venueId: CLOBER_VAULT_VENUE.id,
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

const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

/**
 * Clober oracle-vault adapter — a MIXED-source venue: subgraph for discovery +
 * closed-day backfill, the chain for live quotes + fills.
 *  - discover(): vault (propAMM) books from the subgraph (recent-Open scan fallback).
 *  - backfill(): closed-day vault volume from the subgraph (BookDayData).
 *  - quote():    BookViewer.getExpectedOutput on the vault books.
 *  - decode():   BookManager.Take on vault books, with RouterGateway.Swap for
 *                routed-flow attribution and Open events to fold in new vault books.
 * Non-vault Clober flow is ignored (this venue IS the vault). To also surface
 * independent Clober later: declare a second venue here + stop filtering isVault.
 */
export function createCloberVaultAdapter(): VenueAdapter {
  let books = new Map<string, CloberBook>();   // vault-only book cache
  let vault = new Set<string>();
  let markets: CloberMarket[] = [];

  const mergeVaultBooks = (vaultOpens: any[], bmOpens: any[]): void => {
    for (const l of vaultOpens) {
      const a = l.args; if (!a) continue;
      if (a.bookIdA !== undefined) vault.add(String(a.bookIdA));
      if (a.bookIdB !== undefined) vault.add(String(a.bookIdB));
    }
    let changed = false;
    for (const l of bmOpens) {
      const a = l.args; if (!a) continue;
      const id = String(a.id);
      if (!vault.has(id) || books.has(id)) continue;   // vault-only + not already cached
      const b = cloberBookFromOpen(a, vault);           // null if not MON/stable
      if (b) { books.set(id, b); changed = true; }
    }
    if (changed) markets = assembleCloberMarkets(books);
  };

  return {
    venues: () => [CLOBER_VAULT_VENUE],
    async discover(ctx: AdapterContext) {
      let disc: { books: Map<string, CloberBook>; markets: CloberMarket[]; vault: Set<string> };
      try {
        disc = await discoverCloberViaSubgraph(ctx.config.subgraphUrl);
        ctx.log(`Clober Vault: subgraph discovery (${disc.vault.size} vault book(s))`);
      } catch {
        ctx.log('Clober Vault: subgraph discovery failed; trying recent Open logs');
        try { disc = await discoverClober(2000); } catch { disc = { books: new Map(), markets: [], vault: new Set() }; }
      }
      vault = disc.vault;
      books = new Map([...disc.books].filter(([, b]) => b.isVault));   // keep only vault books
      markets = assembleCloberMarkets(books);
    },
    async backfill(ctx: AdapterContext, sinceUtc: string) {
      const vaultBookIds = [...vault];
      if (!vaultBookIds.length) return {};
      const seed = await seedCloberDaily(ctx.config.subgraphUrl, sinceUtc, [], vaultBookIds);
      return { days: [...seed].map(([utcDay, cd]) => ({ utcDay, byVenue: { [CLOBER_VAULT_VENUE.id]: { usd: cd.vault } } })) };
    },
    quote(ctx, sizesUsd) {
      return quoteClober(markets, sizesUsd, ctx.referenceMid(), ctx.pricer);
    },
    logSources() {
      return [
        { key: 'take', address: ADDR.bookManager as `0x${string}`, events: [ev(bookManagerAbi, 'Take')] },
        { key: 'router', address: ADDR.routerGateway as `0x${string}`, events: [ev(routerGatewayAbi, 'Swap')] },
        { key: 'bmOpen', address: ADDR.bookManager as `0x${string}`, events: [ev(bookManagerAbi, 'Open')] },
        { key: 'vaultOpen', address: ADDR.liquidityVault as `0x${string}`, events: [ev(liquidityVaultAbi, 'Open')] },
      ];
    },
    decode(_ctx: AdapterContext, logs: LogBundle, tsOf) {
      mergeVaultBooks(logs.vaultOpen ?? [], logs.bmOpen ?? []);
      const routerMap = buildRouterMap(logs.router ?? []);
      const out: Fill[] = [];
      for (const l of logs.take ?? []) {
        const f = decodeCloberTake(l, books, tsOf(l.blockNumber), routerMap.get(String(l.transactionHash).toLowerCase()));
        if (f) out.push(f);
      }
      return out;
    },
  };
}
