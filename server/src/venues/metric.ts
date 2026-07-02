import type { PublicClient } from 'viem';
import { parseAbi } from 'viem';
import type { QuoteRow, Fill, Side, VenueMeta } from '@shared';
import { TOKENS, isMonAddress } from '@shared';
import { fromUnits, toUnits, shortHex } from '../util.js';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';

/**
 * Metric OMM adapter — an oracle-anchored bin AMM (propAMM), fully on-chain.
 *
 * Metric pools aren't x*y=k: each pool has a per-pool PriceProvider that feeds an
 * off-chain oracle bid/ask, and the SwapRouter simulates a swap over the pool's
 * binned liquidity around that provided price. So:
 *   PriceProvider.getBidAndAskPrice()  → the fair bid/ask (Q64.64 "X64")
 *   Router.quoteSwap(pool, …, bid, ask) → realized deltas (eth_call, no state change)
 *   Pool.Swap(…, amount0Delta, amount1Delta, …) → the landed fill
 *
 * Scope: only MON/stable pools (this dashboard's universe) are surfaced — Metric's
 * WBTC/WETH pools are different assets and are skipped. No backfill (Metric has no
 * keyless deep-history source here), so its volume accumulates forward from boot.
 * ABIs: @nradko/metric-omm-sdk-v0. Verified live on Monad.
 */

/** Metric display venue — its per-theme color is the single source of truth the frontend reads. */
const METRIC_VENUE: VenueMeta = { id: 'metric', name: 'Metric', color: { light: '#0F9D8C', dark: '#2DD4BF' }, kind: 'amm', role: 'venue' };

/** Shared MetricOmmSwapRouter on Monad (same for every pool). */
const ROUTER = '0xaF9ADa6b6eC7993CE146f6c0bF98f7211CDfD3e5' as const;

/** Metric OMM pools to track — MON/stable only. Verified on-chain (getImmutables
 *  resolves each pool's PriceProvider + token layout, so a stale entry fails loud). */
const KNOWN_POOLS: `0x${string}`[] = [
  '0xFA32f9ec28787d1F9C5BA5c39e54e59984FEF3f0', // wmonusdc → MON/USDC
];

/** Price-limit sentinels (Q64.64) so a quote walks the full binned liquidity for
 *  the size: no upper bound buying MON, no lower bound selling it. */
const PRICE_LIMIT_UP = (1n << 128n) - 1n;
const PRICE_LIMIT_DOWN = 1n;

const metricPoolAbi = parseAbi([
  'function getImmutables() view returns (address factory, address priceProvider, address token0, address token1, uint104 a, uint104 b, uint104 c, bool reportSwapToPriceProvider, uint256 maxDriftE8, uint256 maxDriftDecayPerSecondE8, int16 lowestBin, int16 highestBin, uint256 token0ScaleMultiplier, uint256 token1ScaleMultiplier)',
  'event Swap(address sender, address recipient, bool exactInput, int128 amount0Delta, int128 amount1Delta, int16 newTick, uint104 newPositionInBin)',
]);
const priceProviderAbi = parseAbi(['function getBidAndAskPrice() view returns (uint128, uint128)']);
const metricRouterAbi = parseAbi([
  'function quoteSwap(address pool, bool zeroForOne, int128 amountSpecified, uint128 priceLimitX64, uint128 bidPriceX64, uint128 askPriceX64) returns (int128 amount0Delta, int128 amount1Delta)',
]);

const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

interface MetricPool {
  pool: `0x${string}`;
  priceProvider: `0x${string}`;
  market: string;       // 'MON/USDC'
  monIsToken0: boolean; // is MON (WMON) token0 of the pool?
  stableSym: string;
  stableDec: number;
}

const WMON = TOKENS.WMON;

/**
 * Metric OMM adapter — on-chain discovery (getImmutables) + oracle-quote
 * (PriceProvider + Router.quoteSwap) + Pool.Swap fill decode. No backfill.
 */
export function createMetricAdapter(): VenueAdapter {
  let pools: MetricPool[] = [];
  let byAddr = new Map<string, MetricPool>();
  let discovered = false;

  return {
    venues: () => [METRIC_VENUE],

    async discover(ctx: AdapterContext) {
      const res = await ctx.client.multicall({
        contracts: KNOWN_POOLS.map((p) => ({ address: p, abi: metricPoolAbi, functionName: 'getImmutables' as const })),
        allowFailure: true,
      });
      const found: MetricPool[] = [];
      for (let i = 0; i < KNOWN_POOLS.length; i++) {
        const r = res[i];
        // fail closed: a configured pool that won't resolve is a hard error (held cursor), not a silent skip.
        if (r.status !== 'success') throw new Error(`Metric getImmutables failed for ${KNOWN_POOLS[i]}`);
        const im = r.result as readonly unknown[];
        const priceProvider = im[1] as `0x${string}`;
        const token0 = String(im[2]).toLowerCase();
        const token1 = String(im[3]).toLowerCase();
        // keep exactly MON/stable pools (one side MON, the other a known stable).
        if (isMonAddress(token0) === isMonAddress(token1)) continue;
        const monIsToken0 = isMonAddress(token0);
        const stableAddr = monIsToken0 ? token1 : token0;
        const stable = Object.values(TOKENS).find((t) => t.stable && t.address.toLowerCase() === stableAddr);
        if (!stable) continue;
        found.push({ pool: KNOWN_POOLS[i], priceProvider, market: `MON/${stable.symbol}`, monIsToken0, stableSym: stable.symbol, stableDec: stable.decimals });
      }
      pools = found;
      byAddr = new Map(pools.map((p) => [p.pool.toLowerCase(), p]));
      discovered = true;
      ctx.log(`Metric: ${pools.length} MON/stable pool(s)`);
    },

    async quote(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]> {
      if (!pools.length) return [];
      const monUsd = ctx.referenceMid();
      if (monUsd <= 0) return [];

      // 1) each pool's oracle bid/ask (needed as quoteSwap args).
      const ppRes = await ctx.client.multicall({
        contracts: pools.map((p) => ({ address: p.priceProvider, abi: priceProviderAbi, functionName: 'getBidAndAskPrice' as const })),
        allowFailure: true,
      });

      // 2) quoteSwap for each pool × size, both sides (eth_call — nonpayable, no state change).
      type Leg = { pool: MetricPool; size: number; side: Side; reqIn: bigint };
      const legs: Leg[] = [];
      const calls: { address: `0x${string}`; abi: typeof metricRouterAbi; functionName: 'quoteSwap'; args: readonly [ `0x${string}`, boolean, bigint, bigint, bigint, bigint] }[] = [];
      pools.forEach((p, i) => {
        const r = ppRes[i];
        if (r.status !== 'success') return;
        const [bid, ask] = r.result as readonly [bigint, bigint];
        // zeroForOne swaps token0→token1: selling MON when MON is token0.
        const sellZeroForOne = p.monIsToken0;
        for (const size of sizesUsd) {
          // BUY MON: exact-in the stable, no upper price bound.
          const buyIn = toUnits(size, p.stableDec);
          legs.push({ pool: p, size, side: 'buy', reqIn: buyIn });
          calls.push({ address: ROUTER, abi: metricRouterAbi, functionName: 'quoteSwap', args: [p.pool, !sellZeroForOne, buyIn, PRICE_LIMIT_UP, bid, ask] });
          // SELL MON: exact-in WMON worth `size`, no lower price bound.
          const sellIn = toUnits(ctx.pricer.tokenForUsd('WMON', size), WMON.decimals);
          legs.push({ pool: p, size, side: 'sell', reqIn: sellIn });
          calls.push({ address: ROUTER, abi: metricRouterAbi, functionName: 'quoteSwap', args: [p.pool, sellZeroForOne, sellIn, PRICE_LIMIT_DOWN, bid, ask] });
        }
      });
      if (!calls.length) return [];
      const qRes = await ctx.client.multicall({ contracts: calls, allowFailure: true });

      const rowByKey = new Map<string, QuoteRow>();
      const ts = Date.now();
      const abs = (x: bigint) => (x < 0n ? -x : x);
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const r = qRes[i];
        if (r.status !== 'success') continue;
        const [d0, d1] = r.result as readonly [bigint, bigint];
        const monDelta = l.pool.monIsToken0 ? d0 : d1;
        const stableDelta = l.pool.monIsToken0 ? d1 : d0;
        const monH = fromUnits(abs(monDelta), WMON.decimals);
        const stH = fromUnits(abs(stableDelta), l.pool.stableDec);
        if (monH <= 0 || stH <= 0) continue;
        const px = stH / monH; // stable per MON
        const bps = (px / monUsd - 1) * 1e4;
        // filled full when the exact-input leg consumed (almost) the whole requested input.
        const usedIn = l.side === 'buy' ? abs(stableDelta) : abs(monDelta);
        const legFull = usedIn >= (l.reqIn * 999n) / 1000n;

        const key = `${l.pool.market}|${l.size}`;
        let row = rowByKey.get(key);
        if (!row) {
          row = { venueId: METRIC_VENUE.id, market: l.pool.market, sizeUsd: l.size, bidBps: 0, askBps: 0, bidPx: 0, askPx: 0, spreadBps: 0, filledFull: true, feeBps: 0, ts };
          rowByKey.set(key, row);
        }
        if (l.side === 'buy') { row.askBps = bps; row.askPx = px; }
        else { row.bidBps = bps; row.bidPx = px; }
        row.filledFull &&= legFull;
      }
      for (const row of rowByKey.values()) row.spreadBps = row.askBps - row.bidBps;
      return [...rowByKey.values()].filter((r) => r.askPx > 0 && r.bidPx > 0);
    },

    logSources() {
      if (!discovered) throw new Error('Metric discovery unavailable'); // hold the cursor until discovered
      if (!pools.length) return [];
      return [{ key: 'swap', address: pools.map((p) => p.pool), events: [ev(metricPoolAbi, 'Swap')], kind: 'fills' as const }];
    },

    decode(_ctx: AdapterContext, logs: LogBundle, tsOf) {
      const out: Fill[] = [];
      const abs = (x: bigint) => (x < 0n ? -x : x);
      for (const l of logs.swap ?? []) {
        const p = byAddr.get(String(l.address).toLowerCase());
        if (!p) continue;
        const a = l.args;
        if (!a || a.amount0Delta === undefined || a.amount1Delta === undefined) continue;
        const d0 = BigInt(a.amount0Delta), d1 = BigInt(a.amount1Delta);
        const monDelta = p.monIsToken0 ? d0 : d1;
        const stableDelta = p.monIsToken0 ? d1 : d0;
        const baseAmount = fromUnits(abs(monDelta), WMON.decimals);
        const usd = fromUnits(abs(stableDelta), p.stableDec);
        if (baseAmount <= 0 || usd <= 0) continue;
        const execPx = usd / baseAmount; // realized stable-per-MON (real markouts, no pxApprox)
        // stable INTO the pool (positive delta) ⇒ the trader bought MON.
        const side: Side = stableDelta > 0n ? 'buy' : 'sell';
        out.push({
          id: `metric-${String(l.transactionHash).toLowerCase()}-${l.logIndex}`,
          venueId: METRIC_VENUE.id,
          market: p.market, side, category: 'DIRECT',
          usd, baseAmount, execPx,
          txHash: l.transactionHash, to: shortHex(String(a.recipient ?? '0x')),
          pool: `metric ${p.pool.slice(0, 8)}`,
          blockNumber: Number(l.blockNumber), ts: tsOf(l.blockNumber),
          markoutsBps: [null, null, null, null, null],
        });
      }
      return out;
    },
  };
}
