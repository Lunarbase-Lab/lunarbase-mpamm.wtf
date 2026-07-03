import type { QuoteRow, VenueMeta, Pair } from '@shared';
import { PAIRS, TOKENS, ASSETS, assetOf, pairOf, cexForBase } from '@shared';
import { config } from '../config.js';
import { BybitFeed } from '../bybit.js';
import { BinanceFeed } from '../binance.js';
import type { ReferenceRegistry } from './adapter.js';

/** The CEX benchmark venues (role: 'reference'). Their per-theme color is the
 *  single source of truth the frontend reads. */
const BYBIT_VENUE: VenueMeta = { id: 'bybit', name: 'Bybit', color: { light: '#8A8375', dark: '#B9BCC6' }, kind: 'cex', role: 'reference', taker: true };
const BINANCE_VENUE: VenueMeta = { id: 'binance', name: 'Binance', color: { light: '#B58A1B', dark: '#F0B90B' }, kind: 'cex', role: 'reference', taker: true };

/**
 * The CEX reference registry: Bybit (MON) + Binance (BTC/ETH, VIP9 taker),
 * routed per base asset via the @shared ASSETS registry.
 *
 * The reference for a pair is expressed IN THE PAIR'S OWN TERMS (spec §5.5) —
 * two unit conversions on top of the deep `<BASE>USDT` book, both from live CEX
 * crosses (never assumed):
 *
 *   refPx(pair) = baseUSDT px × wrapBasis(base) ÷ usdtCross(quote)
 *
 *  - wrapBasis: the on-chain asset may be a WRAPPED representation (WBTC), which
 *    trades at a real basis to native (Binance WBTCBTC, ~−5bps live) — without it
 *    every venue shows a fake wrapped-discount "edge".
 *  - usdtCross: on-chain quotes are in the pair's stable (USDC), the CEX book is
 *    USDT — USDC/USDT is a real market (~+10bps live), not 1.0000. The cross is
 *    taken on the SAME exchange as the base feed (Bybit USDCUSDT for MON pairs,
 *    Binance USDCUSDT for BTC/ETH). A stable with no cross (USDT0 ≡ USDT exactly;
 *    AUSD unlisted) falls back to 1 — and an unwarm cross also falls back to 1
 *    rather than zeroing the reference.
 *
 * Taker walks stay on the deep USDT book; realized prices are converted by the
 * same factors at the cross MIDS (both cross books are ~1bp wide, so converting
 * at mid adds <1bp — far smaller than the ~10bp basis it removes).
 */
export function createReferenceRegistry(): ReferenceRegistry {
  // cross symbols per exchange: every stable cross needed by that exchange's
  // pairs, derived from the registries (nothing hardcoded here).
  const bybitCrosses = [...new Set(PAIRS
    .filter((p) => cexForBase(p.base) === 'bybit')
    .map((p) => TOKENS[p.quote]?.usdtCross)
    .filter((s): s is string => !!s))];
  const binanceCrosses = [...new Set(PAIRS
    .filter((p) => cexForBase(p.base) === 'binance')
    .map((p) => TOKENS[p.quote]?.usdtCross)
    .filter((s): s is string => !!s))];
  const wrapSymbols = [...new Set(Object.values(ASSETS).map((a) => a.wrapBasisSymbol).filter((s): s is string => !!s))];
  const baseSymbols = [...new Set(Object.values(ASSETS).filter((a) => a.cex === 'binance').map((a) => a.cexSymbol))];

  const bybit = new BybitFeed(bybitCrosses); // MONUSDT book + cross tickers
  // Binance: base books + stable crosses + wrap-basis symbols (mid-only use for
  // the latter two; the feed maintains small books for them, which is fine).
  const binance = new BinanceFeed([...baseSymbols, ...binanceCrosses, ...wrapSymbols]);

  /** raw USDT-terms mid of a base asset from its CEX. */
  const baseUsdtMid = (base: string): number => {
    const a = assetOf(base);
    if (!a) return 0;
    return a.cex === 'binance' ? binance.mid(a.cexSymbol) : bybit.mid();
  };
  /** wrapped/native factor for a base (1 when not wrapped-adjusted or not warm). */
  const wrapFactor = (base: string): number => {
    const sym = assetOf(base)?.wrapBasisSymbol;
    if (!sym) return 1;
    const m = binance.mid(sym);
    return m > 0 ? m : 1;
  };
  /** stable/USDT cross factor for a pair's quote (1 when ≡USDT, unlisted, or not warm). */
  const crossFactor = (pair: Pair): number => {
    const sym = TOKENS[pair.quote]?.usdtCross;
    if (!sym) return 1;
    const m = cexForBase(pair.base) === 'binance' ? binance.mid(sym) : bybit.crossMid(sym);
    return m > 0 ? m : 1;
  };
  /** full pair conversion: USDT terms → the pair's own (wrapped, stable) terms. */
  const pairFactor = (pair: Pair): number => wrapFactor(pair.base) / crossFactor(pair);

  return {
    async start() { await bybit.start(); await binance.start(); },
    stop() { bybit.stop(); binance.stop(); },
    metas: () => [BYBIT_VENUE, BINANCE_VENUE],
    refVenueIdForBase: (base) => cexForBase(base),
    assetUsd: (base) => baseUsdtMid(base), // USDT ≈ $1 — sizing/header only
    midForPair(market) {
      const pair = pairOf(market);
      if (!pair) return 0;
      const mid = baseUsdtMid(pair.base);
      return mid > 0 ? mid * pairFactor(pair) : 0;
    },
    changePctFor(base) {
      const a = assetOf(base);
      if (!a) return 0;
      return a.cex === 'binance' ? binance.changePct(a.cexSymbol) : bybit.changePct();
    },
    quote(sizesUsd) {
      const rows: QuoteRow[] = [];
      const ts = Date.now();
      for (const pair of PAIRS) {
        const a = assetOf(pair.base);
        if (!a) continue;
        const usdtMid = baseUsdtMid(pair.base);
        if (usdtMid <= 0) continue; // feed not warm yet — no benchmark row
        const factor = pairFactor(pair);
        const pxMid = usdtMid * factor; // the pair-terms mid (bps anchor)
        const isBinance = a.cex === 'binance';
        const feeBps = isBinance ? config.binanceTakerBps : config.takerBps;
        const fee = feeBps / 1e4;
        const venueId = isBinance ? BINANCE_VENUE.id : BYBIT_VENUE.id;
        for (const size of sizesUsd) {
          const base = size / usdtMid; // sizing in USDT≈USD terms
          const buy = isBinance ? binance.walk(a.cexSymbol, 'buy', base) : bybit.walk('buy', base);
          const sell = isBinance ? binance.walk(a.cexSymbol, 'sell', base) : bybit.walk('sell', base);
          // realized walk prices converted into the pair's terms by the same factor
          const askPx = buy.price * factor * (1 + fee);
          const bidPx = sell.price * factor * (1 - fee);
          rows.push({
            venueId, market: pair.symbol, sizeUsd: size,
            askPx, bidPx, askBps: (askPx / pxMid - 1) * 1e4, bidBps: (bidPx / pxMid - 1) * 1e4,
            spreadBps: ((askPx - bidPx) / pxMid) * 1e4,
            filledFull: buy.filledFull && sell.filledFull, feeBps, ts,
          });
        }
      }
      return rows;
    },
  };
}
