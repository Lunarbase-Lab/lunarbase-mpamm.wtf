import { TOKENS, assetForToken } from '@shared';

/**
 * UsdPricer (spec §5.5) — shared by the poller (USD→token notional sizing) and
 * the stream (token→USD volume). Stables peg to $1; a base asset (MON/BTC/ETH)
 * is priced by its CEX via `assetUsd(assetKey)` (Bybit for MON, Binance for the
 * rest — routed through the reference registry). Fully asset-generic: it maps a
 * token → its base asset → USD price, so a new asset needs no pricer change.
 */
export class UsdPricer {
  constructor(private readonly assetUsd: (assetKey: string) => number) {}

  usdPerToken(symbol: string): number {
    const t = TOKENS[symbol];
    if (!t) return 0;
    if (t.stable) return 1;
    const asset = assetForToken(t.address); // WMON→MON, WBTC→BTC, WETH→ETH
    return asset ? this.assetUsd(asset.key) : 0;
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
