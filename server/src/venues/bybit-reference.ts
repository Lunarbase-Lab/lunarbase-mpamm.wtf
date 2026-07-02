import type { QuoteRow, VenueMeta } from '@shared';
import { MARKETS } from '@shared';
import { BybitFeed } from '../bybit.js';
import type { ReferenceAdapter, AdapterContext } from './adapter.js';

/** Bybit — the CEX reference venue (role: 'reference'), walked as a taker. */
const BYBIT_VENUE: VenueMeta = { id: 'bybit', name: 'Bybit', color: { light: '#8A8375', dark: '#B9BCC6' }, kind: 'cex', role: 'reference', taker: true };

/**
 * Bybit reference — the benchmark for markouts and the Execution comparison, NOT
 * a fill-producing venue. Wraps the BybitFeed order-book and produces one taker
 * bid/ask per market×size (the same book-walk the live source used).
 */
export function createBybitReference(): ReferenceAdapter {
  const feed = new BybitFeed();
  return {
    meta: () => BYBIT_VENUE,
    start: () => feed.start(),
    stop: () => feed.stop(),
    monUsd: () => feed.monUsd(),
    mid: () => feed.mid(),
    changePct: () => feed.changePct(),
    quote(ctx: AdapterContext, sizesUsd) {
      const monUsd = feed.monUsd();
      const rows: QuoteRow[] = [];
      if (monUsd <= 0) return rows;
      const fee = ctx.config.takerBps / 1e4;
      const ts = Date.now();
      for (const market of MARKETS) {
        for (const size of sizesUsd) {
          const base = size / monUsd;
          const buy = feed.walk('buy', base);
          const sell = feed.walk('sell', base);
          const askPx = buy.price * (1 + fee);
          const bidPx = sell.price * (1 - fee);
          rows.push({
            venueId: BYBIT_VENUE.id, market, sizeUsd: size,
            askPx, bidPx, askBps: (askPx / monUsd - 1) * 1e4, bidBps: (bidPx / monUsd - 1) * 1e4,
            spreadBps: ((askPx - bidPx) / monUsd) * 1e4,
            filledFull: buy.filledFull && sell.filledFull, feeBps: ctx.config.takerBps, ts,
          });
        }
      }
      return rows;
    },
  };
}
