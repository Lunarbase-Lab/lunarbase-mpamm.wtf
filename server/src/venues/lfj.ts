import type { PublicClient } from 'viem';
import type { QuoteRow, Side, Fill, VenueMeta } from '@shared';
import { TOKENS } from '@shared';
import { lbFactoryAbi, lbPairAbi } from '../chain/abis.js';
import { ADDR } from '@shared';
import { fromUnits, toUnits, shortHex } from '../util.js';
import type { UsdPricer } from '../pricer.js';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';

/** LFJ display venue — its `color` (per theme) is the single source of truth the
 *  frontend reads; nothing about LFJ is hardcoded outside this adapter. */
const LFJ_VENUE: VenueMeta = { id: 'lfj', name: 'LFJ', color: { light: '#FF4D00', dark: '#6E8BFF' }, kind: 'amm', role: 'venue' };

/** A discovered LFJ Liquidity Book market (MON vs one stable). */
export interface LbMarket {
  market: string;            // 'MON/USDC'
  pair: `0x${string}`;       // LBPair address
  stable: string;            // 'USDC'
  monIsX: boolean;           // is MON (WMON) tokenX of the pair?
  binStep: number;
}

const WMON = TOKENS.WMON;

/** Discover LBPairs for WMON × each stable via LBFactory.getAllLBPairs.
 *  Picks the deepest (smallest binStep, first) pair per stable. */
export async function discoverLfj(client: PublicClient): Promise<LbMarket[]> {
  const stables = Object.values(TOKENS).filter((t) => t.stable);
  const calls = stables.map((s) => ({
    address: ADDR.lbFactory as `0x${string}`,
    abi: lbFactoryAbi,
    functionName: 'getAllLBPairs' as const,
    args: [WMON.address, s.address] as const,
  }));
  const res = await client.multicall({ contracts: calls, allowFailure: true });

  const out: LbMarket[] = [];
  for (let i = 0; i < stables.length; i++) {
    const r = res[i];
    if (r.status !== 'success') continue;
    const infos = r.result as ReadonlyArray<{ binStep: number; LBPair: `0x${string}`; ignoredForRouting: boolean }>;
    const usable = infos.filter((p) => !p.ignoredForRouting && p.LBPair !== '0x0000000000000000000000000000000000000000');
    if (!usable.length) continue;
    usable.sort((a, b) => a.binStep - b.binStep);
    const pick = usable[0];
    out.push({
      market: `MON/${stables[i].symbol}`,
      pair: pick.LBPair,
      stable: stables[i].symbol,
      monIsX: false, // resolved below
      binStep: pick.binStep,
    });
  }
  if (!out.length) return out;

  // resolve token order (which of X/Y is WMON) per pair
  const tokCalls = out.flatMap((m) => [
    { address: m.pair, abi: lbPairAbi, functionName: 'getTokenX' as const },
    { address: m.pair, abi: lbPairAbi, functionName: 'getTokenY' as const },
  ]);
  const tok = await client.multicall({ contracts: tokCalls, allowFailure: true });
  for (let i = 0; i < out.length; i++) {
    const x = tok[i * 2], _y = tok[i * 2 + 1];
    if (x.status === 'success') {
      out[i].monIsX = (x.result as string).toLowerCase() === WMON.address.toLowerCase();
    }
  }
  return out;
}

interface QuoteLeg {
  market: string;
  size: number;
  side: Side;
  amountIn: bigint;
  swapForY: boolean;
  inDecimals: number;
  outDecimals: number;
}

/** Quote LFJ for every market × size, both sides, in a single Multicall3
 *  round-trip (spec §5.1). Returns one QuoteRow per (market,size). */
export async function quoteLfj(
  client: PublicClient,
  markets: LbMarket[],
  sizesUsd: readonly number[],
  monUsd: number,
  pricer: UsdPricer,
): Promise<QuoteRow[]> {
  if (!markets.length || monUsd <= 0) return [];
  const legs: QuoteLeg[] = [];
  for (const m of markets) {
    const stable = TOKENS[m.stable];
    for (const size of sizesUsd) {
      // BUY MON: spend stable, receive MON. input=stable.
      // swapForY swaps X→Y; we want MON out, so swapForY = stable is X (MON is Y)
      const buyStableIsX = !m.monIsX;
      legs.push({
        market: m.market, size, side: 'buy',
        amountIn: toUnits(size, stable.decimals),
        swapForY: buyStableIsX,
        inDecimals: stable.decimals, outDecimals: WMON.decimals,
      });
      // SELL MON: spend MON, receive stable. input=MON.
      const sellMonIsX = m.monIsX;
      legs.push({
        market: m.market, size, side: 'sell',
        amountIn: toUnits(pricer.tokenForUsd('WMON', size), WMON.decimals),
        swapForY: sellMonIsX,
        inDecimals: WMON.decimals, outDecimals: stable.decimals,
      });
    }
  }

  const pairByMarket = new Map(markets.map((m) => [m.market, m.pair] as const));
  const contracts = legs.map((l) => ({
    address: pairByMarket.get(l.market)!,
    abi: lbPairAbi,
    functionName: 'getSwapOut' as const,
    args: [l.amountIn, l.swapForY] as const,
  }));
  const res = await client.multicall({ contracts, allowFailure: true });

  // fold the two legs of each (market,size) into a QuoteRow
  const rowByKey = new Map<string, QuoteRow>();
  const ts = Date.now();
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    const r = res[i];
    if (r.status !== 'success') continue;
    const [amountInLeft, amountOut, fee] = r.result as readonly [bigint, bigint, bigint];
    const usedIn = l.amountIn - amountInLeft;
    if (usedIn <= 0n || amountOut <= 0n) continue;
    const inHuman = fromUnits(usedIn, l.inDecimals);
    const outHuman = fromUnits(amountOut, l.outDecimals);
    const filledFull = amountInLeft === 0n;
    const feeBps = l.amountIn > 0n ? (Number(fee) / Number(l.amountIn)) * 1e4 : 0;

    // realized price = stable-per-MON (quote per base)
    const px = l.side === 'buy' ? inHuman / outHuman : outHuman / inHuman;
    const bps = (px / monUsd - 1) * 1e4;

    const key = `${l.market}|${l.size}`;
    let row = rowByKey.get(key);
    if (!row) {
      row = {
        venueId: LFJ_VENUE.id, market: l.market, sizeUsd: l.size,
        bidBps: 0, askBps: 0, bidPx: 0, askPx: 0, spreadBps: 0,
        filledFull: true, feeBps: 0, ts,
      };
      rowByKey.set(key, row);
    }
    if (l.side === 'buy') { row.askBps = bps; row.askPx = px; }
    else { row.bidBps = bps; row.bidPx = px; }
    row.feeBps = Math.max(row.feeBps, feeBps);
    row.filledFull &&= filledFull;
  }
  for (const row of rowByKey.values()) row.spreadBps = row.askBps - row.bidBps;
  return [...rowByKey.values()].filter((r) => r.askPx > 0 && r.bidPx > 0);
}

/** Decode an LFJ Swap log into a normalized Fill. amounts are two uint128
 *  packed in one bytes32 (low128=X, high128=Y); no byte reversal (spec §5.2). */
export function decodeLfjSwap(
  log: { args: any; transactionHash: string; blockNumber: bigint; address: string; logIndex: number },
  market: LbMarket,
  tsMs: number,
): Fill | null {
  const a = log.args;
  if (!a) return null;
  const amountsIn = BigInt(a.amountsIn);
  const amountsOut = BigInt(a.amountsOut);
  const MASK = (1n << 128n) - 1n;
  const inX = amountsIn & MASK, inY = amountsIn >> 128n;
  const outX = amountsOut & MASK, outY = amountsOut >> 128n;

  const stable = TOKENS[market.stable];
  const monDec = TOKENS.WMON.decimals, stDec = stable.decimals;
  // X/Y → which is MON
  const inMon = market.monIsX ? inX : inY;
  const outMon = market.monIsX ? outX : outY;
  const inStable = market.monIsX ? inY : inX;
  const outStable = market.monIsX ? outY : outX;

  const isBuy = inStable > 0n; // spent stable, received MON
  const baseAmount = fromUnits(isBuy ? outMon : inMon, monDec);
  const stableAmount = fromUnits(isBuy ? inStable : outStable, stDec);
  if (baseAmount <= 0 || stableAmount <= 0) return null;
  const execPx = stableAmount / baseAmount;

  return {
    // deterministic id: a (txHash, logIndex) pair is unique per on-chain event,
    // so a re-tail / gap-fill / restart re-decode dedupes instead of duplicating.
    id: `lfj-${log.transactionHash.toLowerCase()}-${log.logIndex}`,
    venueId: LFJ_VENUE.id,
    market: market.market, side: isBuy ? 'buy' : 'sell', category: 'DIRECT',
    usd: stableAmount, baseAmount, execPx,
    txHash: log.transactionHash, to: shortHex(a.to ?? '0x'),
    pool: shortHex(market.pair),
    blockNumber: Number(log.blockNumber), ts: tsMs,
    markoutsBps: [null, null, null, null, null],
  };
}

const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

/**
 * LFJ Liquidity Book adapter — fully on-chain, no subgraph. Discovers pairs via
 * LBFactory, quotes via LBPair.getSwapOut, decodes LBPair.Swap logs. No
 * backfill(), so LFJ history accumulates forward from first run.
 */
export function createLfjAdapter(): VenueAdapter {
  let markets: LbMarket[] = [];
  let byAddr = new Map<string, LbMarket>();
  return {
    venues: () => [LFJ_VENUE],
    async discover(ctx: AdapterContext) {
      markets = await discoverLfj(ctx.client);
      byAddr = new Map(markets.map((m) => [m.pair.toLowerCase(), m]));
      ctx.log(`LFJ: ${markets.length} market(s)`);
    },
    quote(ctx, sizesUsd) {
      return quoteLfj(ctx.client, markets, sizesUsd, ctx.referenceMid(), ctx.pricer);
    },
    logSources() {
      if (!markets.length) return [];
      return [{ key: 'swap', address: markets.map((m) => m.pair), events: [ev(lbPairAbi, 'Swap')] }];
    },
    decode(_ctx: AdapterContext, logs: LogBundle, tsOf) {
      const out: Fill[] = [];
      for (const l of logs.swap ?? []) {
        const m = byAddr.get(String(l.address).toLowerCase());
        if (!m) continue;
        const f = decodeLfjSwap(l, m, tsOf(l.blockNumber));
        if (f) out.push(f);
      }
      return out;
    },
  };
}
