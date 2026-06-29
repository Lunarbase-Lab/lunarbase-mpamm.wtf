import { TOKENS } from '@shared';

/**
 * UsdPricer (spec §5.5) — shared by the poller (USD→token notional sizing) and
 * the stream (token→USD volume). Stables peg to $1; MON/WMON priced off Bybit.
 */
export class UsdPricer {
  constructor(private readonly monUsd: () => number) {}

  usdPerToken(symbol: string): number {
    const t = TOKENS[symbol];
    if (!t) return 0;
    if (t.stable) return 1;
    return this.monUsd();
  }

  /** token amount (human units) for a USD notional. */
  tokenForUsd(symbol: string, usd: number): number {
    const px = this.usdPerToken(symbol);
    return px > 0 ? usd / px : 0;
  }

  usdForToken(symbol: string, amount: number): number {
    return amount * this.usdPerToken(symbol);
  }
}
