import { parseAbi } from 'viem';
import type { QuoteRow, Fill, Side, VenueMeta } from '@shared';
import { TOKENS, isMonAddress } from '@shared';
import { fromUnits, toUnits, shortHex } from '../util.js';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';

/**
 * LFJ POE adapter — LFJ's "Public Prop AMM" on Monad, fully on-chain.
 *
 * POE is a propAMM, NOT LFJ's Liquidity Book: each pool prices off a ClapOracle
 * (Concentrated-Liquidity Constant-Product), market makers set price/ranges/fees,
 * and depositors fund the vault. Unlike Metric we don't fetch the oracle bid/ask
 * ourselves — the pool's own `getQuote` returns an executable, fee-inclusive
 * amount, so the read is a single view call:
 *   Factory.getPool(x, y)                        → the pool for a token pair
 *   Pool.getTokens()                             → canonical tokenX / tokenY
 *   Pool.getQuote(swapXtoY, amountIn)            → amountOut (+ actualAmountIn, fees)
 *   Pool.Swap(…, actualAmountIn, amountOut, …)   → the landed fill
 *
 * Scope: MON/stable pools only (this dashboard's universe) — POE's stable/stable
 * pools (e.g. AUSD/USDC) are skipped. No backfill (no keyless deep-history source),
 * so volume accumulates forward from boot. ABIs: LFJ POE OraclePool
 * (developers.lfj.gg/poe). Verified live on Monad.
 */

/** LFJ POE display venue — keeps LFJ's brand palette (POE is an LFJ product). The
 *  per-theme color is the single source of truth the frontend reads. */
const POE_VENUE: VenueMeta = { id: 'poe', name: 'LFJ POE', color: { light: '#FF4D00', dark: '#6E8BFF' }, kind: 'amm', role: 'venue' };

/** POE OraclePoolFactory on Monad (sorts token args internally). */
const FACTORY = '0x78120F2C0EBF0cc8B7E7749e62D36e6523dD711D' as const;

const poeFactoryAbi = parseAbi([
  'function getPool(address tokenX, address tokenY) view returns (address)',
]);
const poePoolAbi = parseAbi([
  'function getTokens() view returns (address tokenX, address tokenY)',
  'function getQuote(bool swapXtoY, uint256 amountIn) view returns (uint256 amountOut, uint256 actualAmountIn, uint256 feeIn, uint256 feeOut)',
  'event Swap(address indexed sender, address indexed recipient, bool indexed swapXtoY, uint256 actualAmountIn, uint256 amountOut, uint256 feeIn, uint256 feeOut)',
]);

const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

interface PoePool {
  pool: `0x${string}`;
  market: string;    // 'MON/USDC'
  monIsX: boolean;   // is MON (WMON) tokenX of the pool?
  stableSym: string;
  stableDec: number;
}

const WMON = TOKENS.WMON;

/**
 * LFJ POE adapter — on-chain discovery (Factory.getPool + Pool.getTokens) +
 * executable quotes (Pool.getQuote) + Pool.Swap fill decode. No backfill.
 */
export function createPoeAdapter(): VenueAdapter {
  // MERGE, never replace (LFJ review #3): getPool is a factory READ, not a
  // cursor-holding log source, so a transient/partial discovery must only
  // ADD/refresh pools — never shrink the tailed set (which would advance the
  // cursor past an omitted pool's swaps) or drop an address a live tail may
  // still decode against.
  const byMarket = new Map<string, PoePool>(); // current pick per market — source of truth for tailing/quoting
  const byAddr = new Map<string, PoePool>();   // every pool ever seen — for decode lookups
  let discovered = false;

  return {
    venues: () => [POE_VENUE],

    async discover(ctx: AdapterContext) {
      const stables = Object.values(TOKENS).filter((t) => t.stable);
      // phase 1: resolve the POE pool for each MON/stable pair.
      const poolRes = await ctx.client.multicall({
        contracts: stables.map((s) => ({ address: FACTORY, abi: poeFactoryAbi, functionName: 'getPool' as const, args: [WMON.address, s.address] as const })),
        allowFailure: true,
      });
      const candidates: { pool: `0x${string}`; stable: (typeof stables)[number] }[] = [];
      for (let i = 0; i < stables.length; i++) {
        const r = poolRes[i];
        // fail closed: an RPC error on a configured lookup holds the cursor (throws),
        // rather than silently dropping a pool we'd otherwise tail.
        if (r.status !== 'success') throw new Error(`POE getPool failed for ${WMON.symbol}/${stables[i].symbol}`);
        const addr = String(r.result).toLowerCase() as `0x${string}`;
        if (addr === '0x0000000000000000000000000000000000000000') continue; // no POE pool for this pair — normal
        candidates.push({ pool: addr, stable: stables[i] });
      }
      if (!candidates.length) { discovered = true; ctx.log(`POE: 0 MON/stable pool(s)`); return; }

      // phase 2: resolve canonical token order (which side is WMON) per pool.
      const tokRes = await ctx.client.multicall({
        contracts: candidates.map((c) => ({ address: c.pool, abi: poePoolAbi, functionName: 'getTokens' as const })),
        allowFailure: true,
      });
      for (let i = 0; i < candidates.length; i++) {
        const r = tokRes[i];
        if (r.status !== 'success') throw new Error(`POE getTokens failed for ${candidates[i].pool}`);
        const [tx, ty] = r.result as readonly [string, string];
        const xIsMon = isMonAddress(tx), yIsMon = isMonAddress(ty);
        if (xIsMon === yIsMon) throw new Error(`POE pool ${candidates[i].pool} is not a MON/stable pool`); // fail closed
        const p: PoePool = {
          pool: candidates[i].pool,
          market: `MON/${candidates[i].stable.symbol}`,
          monIsX: xIsMon,
          stableSym: candidates[i].stable.symbol,
          stableDec: candidates[i].stable.decimals,
        };
        byMarket.set(p.market, p);
        byAddr.set(p.pool.toLowerCase(), p);
      }
      discovered = true;
      ctx.log(`POE: ${byMarket.size} MON/stable pool(s)`);
    },

    async quote(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]> {
      const pools = [...byMarket.values()];
      if (!pools.length) return [];
      const monUsd = ctx.referenceMid();
      if (monUsd <= 0) return [];

      // getQuote(swapXtoY, amountIn) per pool × size × side (view — eth_call).
      type Leg = { pool: PoePool; size: number; side: Side; reqIn: bigint; inDec: number; outDec: number };
      const legs: Leg[] = [];
      const calls: { address: `0x${string}`; abi: typeof poePoolAbi; functionName: 'getQuote'; args: readonly [boolean, bigint] }[] = [];
      for (const p of pools) {
        for (const size of sizesUsd) {
          // BUY MON: spend the stable. swapXtoY sends X→Y, so buying MON is X→Y when
          // the stable is X (i.e. MON is NOT X).
          const buyIn = toUnits(size, p.stableDec);
          legs.push({ pool: p, size, side: 'buy', reqIn: buyIn, inDec: p.stableDec, outDec: WMON.decimals });
          calls.push({ address: p.pool, abi: poePoolAbi, functionName: 'getQuote', args: [!p.monIsX, buyIn] });
          // SELL MON: spend WMON worth `size`. swapXtoY when MON IS X.
          const sellIn = toUnits(ctx.pricer.tokenForUsd('WMON', size), WMON.decimals);
          legs.push({ pool: p, size, side: 'sell', reqIn: sellIn, inDec: WMON.decimals, outDec: p.stableDec });
          calls.push({ address: p.pool, abi: poePoolAbi, functionName: 'getQuote', args: [p.monIsX, sellIn] });
        }
      }
      if (!calls.length) return [];
      const res = await ctx.client.multicall({ contracts: calls, allowFailure: true });

      const rowByKey = new Map<string, QuoteRow>();
      const ts = Date.now();
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const r = res[i];
        if (r.status !== 'success') continue;
        const [amountOut, actualAmountIn, feeIn, feeOut] = r.result as readonly [bigint, bigint, bigint, bigint];
        if (amountOut <= 0n || actualAmountIn <= 0n) continue;
        const inH = fromUnits(actualAmountIn, l.inDec);
        const outH = fromUnits(amountOut, l.outDec);
        if (inH <= 0 || outH <= 0) continue;
        // realized stable-per-MON (all-in; actualAmountIn is gross of fee)
        const px = l.side === 'buy' ? inH / outH : outH / inH;
        const bps = (px / monUsd - 1) * 1e4;
        // filled full when the pool consumed (almost) the whole requested input.
        const legFull = actualAmountIn >= (l.reqIn * 999n) / 1000n;
        const feeBps = ((actualAmountIn > 0n ? Number(feeIn) / Number(actualAmountIn) : 0) + (amountOut > 0n ? Number(feeOut) / Number(amountOut) : 0)) * 1e4;

        const key = `${l.pool.market}|${l.size}`;
        let row = rowByKey.get(key);
        if (!row) {
          row = { venueId: POE_VENUE.id, market: l.pool.market, sizeUsd: l.size, bidBps: 0, askBps: 0, bidPx: 0, askPx: 0, spreadBps: 0, filledFull: true, feeBps: 0, ts };
          rowByKey.set(key, row);
        }
        if (l.side === 'buy') { row.askBps = bps; row.askPx = px; }
        else { row.bidBps = bps; row.bidPx = px; }
        row.feeBps = Math.max(row.feeBps, feeBps);
        row.filledFull &&= legFull;
      }
      for (const row of rowByKey.values()) row.spreadBps = row.askBps - row.bidBps;
      return [...rowByKey.values()].filter((r) => r.askPx > 0 && r.bidPx > 0);
    },

    logSources() {
      if (!discovered) throw new Error('POE discovery unavailable'); // hold the cursor until discovered
      const pairs = [...byMarket.values()].map((p) => p.pool);
      if (!pairs.length) return [];
      return [{ key: 'swap', address: pairs, events: [ev(poePoolAbi, 'Swap')], kind: 'fills' as const }];
    },

    decode(_ctx: AdapterContext, logs: LogBundle, tsOf) {
      const out: Fill[] = [];
      for (const l of logs.swap ?? []) {
        const p = byAddr.get(String(l.address).toLowerCase());
        if (!p) continue;
        const a = l.args;
        if (!a || a.actualAmountIn === undefined || a.amountOut === undefined) continue;
        const actualAmountIn = BigInt(a.actualAmountIn), amountOut = BigInt(a.amountOut);
        // swapXtoY sends tokenX→tokenY, so the input is MON exactly when swapXtoY === monIsX.
        const inputIsMon = Boolean(a.swapXtoY) === p.monIsX;
        const monRaw = inputIsMon ? actualAmountIn : amountOut;
        const stableRaw = inputIsMon ? amountOut : actualAmountIn;
        const baseAmount = fromUnits(monRaw, WMON.decimals);
        const usd = fromUnits(stableRaw, p.stableDec);
        if (baseAmount <= 0 || usd <= 0) continue;
        const execPx = usd / baseAmount; // realized stable-per-MON (real markouts, no pxApprox)
        const side: Side = inputIsMon ? 'sell' : 'buy'; // spent MON ⇒ sell
        out.push({
          id: `poe-${String(l.transactionHash).toLowerCase()}-${l.logIndex}`,
          venueId: POE_VENUE.id,
          market: p.market, side, category: 'DIRECT',
          usd, baseAmount, execPx,
          txHash: l.transactionHash, to: shortHex(String(a.recipient ?? '0x')),
          pool: `poe ${p.pool.slice(0, 8)}`,
          blockNumber: Number(l.blockNumber), ts: tsOf(l.blockNumber),
          markoutsBps: [null, null, null, null, null],
        });
      }
      return out;
    },
  };
}
