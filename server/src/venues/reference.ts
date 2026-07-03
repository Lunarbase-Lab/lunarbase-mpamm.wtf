import type { QuoteRow, VenueMeta } from '@shared';
import { PAIRS, ASSETS, assetOf, cexForBase } from '@shared';
import { config } from '../config.js';
import { BybitFeed } from '../bybit.js';
import { BinanceFeed } from '../binance.js';
import type { ReferenceRegistry } from './adapter.js';

/** The CEX benchmark venues (role: 'reference'). Their per-theme color is the
 *  single source of truth the frontend reads. */
const BYBIT_VENUE: VenueMeta = { id: 'bybit', name: 'Bybit', color: { light: '#8A8375', dark: '#B9BCC6' }, kind: 'cex', role: 'reference', taker: true };
const BINANCE_VENUE: VenueMeta = { id: 'binance', name: 'Binance', color: { light: '#B58A1B', dark: '#F0B90B' }, kind: 'cex', role: 'reference', taker: true };

/**
 * The CEX reference registry: Bybit (MON) + Binance (BTC/ETH, VIP9 taker). Every
 * price/mid/walk is routed by the asset's `cex` from the @shared ASSETS registry,
 * so listing a new asset needs only a registry entry — no code here. Binance
 * symbols are derived from ASSETS (the `cex: 'binance'` entries).
 */
export function createReferenceRegistry(): ReferenceRegistry {
  const bybit = new BybitFeed(); // MONUSDT (config.bybitSymbol)
  const binanceSymbols = [...new Set(Object.values(ASSETS).filter((a) => a.cex === 'binance').map((a) => a.cexSymbol))];
  const binance = new BinanceFeed(binanceSymbols);

  const usdOf = (base: string): number => {
    const a = assetOf(base);
    if (!a) return 0;
    return a.cex === 'binance' ? binance.assetUsd(a.cexSymbol) : bybit.monUsd();
  };
  const midOf = (base: string): number => {
    const a = assetOf(base);
    if (!a) return 0;
    return a.cex === 'binance' ? binance.mid(a.cexSymbol) : bybit.mid();
  };

  return {
    async start() { await bybit.start(); await binance.start(); },
    stop() { bybit.stop(); binance.stop(); },
    metas: () => [BYBIT_VENUE, BINANCE_VENUE],
    refVenueIdForBase: (base) => cexForBase(base),
    assetUsd: usdOf,
    midFor: midOf,
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
        const px = usdOf(pair.base);
        if (px <= 0) continue; // feed not warm yet — no benchmark row
        const isBinance = a.cex === 'binance';
        const feeBps = isBinance ? config.binanceTakerBps : config.takerBps;
        const fee = feeBps / 1e4;
        const venueId = isBinance ? BINANCE_VENUE.id : BYBIT_VENUE.id;
        for (const size of sizesUsd) {
          const base = size / px;
          const buy = isBinance ? binance.walk(a.cexSymbol, 'buy', base) : bybit.walk('buy', base);
          const sell = isBinance ? binance.walk(a.cexSymbol, 'sell', base) : bybit.walk('sell', base);
          const askPx = buy.price * (1 + fee);
          const bidPx = sell.price * (1 - fee);
          rows.push({
            venueId, market: pair.symbol, sizeUsd: size,
            askPx, bidPx, askBps: (askPx / px - 1) * 1e4, bidBps: (bidPx / px - 1) * 1e4,
            spreadBps: ((askPx - bidPx) / px) * 1e4,
            filledFull: buy.filledFull && sell.filledFull, feeBps, ts,
          });
        }
      }
      return rows;
    },
  };
}
