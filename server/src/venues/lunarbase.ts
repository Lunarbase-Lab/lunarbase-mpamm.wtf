import { quoteXToY, quoteYToX } from '@lunarbase-lab/pmm-math';
import type { QuoteParams, QuoteResult } from '@lunarbase-lab/pmm-math';
import { parseAbi } from 'viem';
import type { Fill, QuoteRow, Side, VenueMeta } from '@shared';
import { NATIVE_MON, TOKENS, pairFor, pairOf } from '@shared';
import { fromUnits, shortHex, toUnits } from '../util.js';
import type { AdapterContext, LogBundle, VenueAdapter } from './adapter.js';

/**
 * Lunarbase adapter — quotes current Pool state locally with the canonical PMM
 * package. State events keep a monotonic recovery cache, but every live quote
 * is rebuilt from one atomic current-block snapshot: the core quotes before
 * tailing finalized logs, so an event-only cache would lag by several blocks.
 *
 * The displayed route is Lunarbase's production aggregator path. Aggregators
 * enter through whitelisted execution adapters, so feeMultiplier is always 1;
 * the representative execution adapter is verified on-chain at every snapshot.
 */

const LUNARBASE_VENUE: VenueMeta = {
  id: 'lunarbase',
  name: 'Lunarbase',
  color: { light: '#036B8C', dark: '#4CC9F0' },
  kind: 'amm',
  role: 'venue',
  sinceUtc: '2026-04-30',
};

const MON_POOL = '0x0000a8fd148694aE3E17c079Ce4BBF8187758888' as const;
const CBBTC_POOL = '0xb1C8eAd40da9b6AfcB6f34B15e10123505c38888' as const;
const WHITELIST_PROBE = '0x8f10b468b06c6fd214b65f87778827f7d113f996' as const;
const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
const MAX_U128 = (1n << 128n) - 1n;
const MAX_LOG_INDEX = Number.MAX_SAFE_INTEGER;
const ZERO = '0x0000000000000000000000000000000000000000';

const CURRENT_STATE_TOPIC = '0x8acb811d2c5106785f847faf03ce160d2eb124b8632eb42d466f46c087033d61' as const;
const LEGACY_MON_STATE_TOPIC = '0xcde511305d043cb248593e7b0abb95a2ffc42c537f4435006a9e4018689f5174' as const;

const poolAbi = parseAbi([
  'function X() view returns (address)',
  'function Y() view returns (address)',
  'function state() view returns (uint160 anchorPrice, uint24 feeAskX24, uint24 feeBidX24, uint48 latestUpdateBlock)',
  'function getXReserve() view returns (uint112)',
  'function getYReserve() view returns (uint112)',
  'function concentrationK() view returns (uint32)',
  'function blockDelay() view returns (uint48)',
  'function paused() view returns (bool)',
  'function blacklistFeeMultiplier() view returns (uint256)',
  'function isWhitelisted(address account) view returns (bool)',
  'function quoteXToY(uint256 amountIn) view returns (uint256 amountOut, uint160 sqrtPriceNext, uint256 fee)',
  'function quoteYToX(uint256 amountIn) view returns (uint256 amountOut, uint160 sqrtPriceNext, uint256 fee)',
  'event SwapExecuted(address recipient, bool xToY, uint256 dx, uint256 dy, uint256 fee)',
  'event StateUpdated(uint160 anchorPrice, uint24 feeAskX24, uint24 feeBidX24)',
  'event Sync(uint128 reserveX, uint128 reserveY)',
  'event ConcentrationKSet(uint32 concentrationK)',
  'event BlockDelaySet(uint48 blockDelay)',
  'event WhitelistSet(address indexed account, bool whitelisted)',
  'event BlacklistFeeMultiplierSet(uint256 multiplier)',
  'event Paused(address account)',
  'event Unpaused(address account)',
  'event Upgraded(address indexed implementation)',
]);
const erc20Abi = parseAbi(['function decimals() view returns (uint8)']);
const event = (name: string) => poolAbi.find((x: any) => x.type === 'event' && x.name === name)!;

export interface LunarbasePoolConfig {
  pool: `0x${string}`;
  expectedImplementation: `0x${string}`;
  market: string;
  expectedX: `0x${string}`;
  expectedY: `0x${string}`;
  baseIsX: boolean;
  baseToken: string;
  stableToken: string;
  baseDec: number;
  stableDec: number;
}

export interface LunarbaseSnapshot {
  blockNumber: bigint;
  implementation: `0x${string}`;
  anchorPrice: bigint;
  feeAskX24: number;
  feeBidX24: number;
  latestUpdateBlock: bigint;
  reserveX: bigint;
  reserveY: bigint;
  concentrationK: number;
  blockDelay: bigint;
  paused: boolean;
  blacklistFeeMultiplier: bigint;
  whitelistProbe: boolean;
}

interface LogPosition {
  blockNumber: bigint;
  logIndex: number;
}

export interface LunarbaseCachedPool extends LunarbasePoolConfig {
  snapshot: LunarbaseSnapshot;
  lastApplied: LogPosition;
  needsRediscovery: boolean;
}

export const LUNARBASE_POOLS: readonly LunarbasePoolConfig[] = [
  {
    pool: MON_POOL,
    expectedImplementation: '0x3D521E7a72E7e3F3BD82CFDC7bf10fFE69CF2446',
    market: 'MON/USDC',
    expectedX: NATIVE_MON,
    expectedY: TOKENS.USDC.address,
    baseIsX: true,
    baseToken: 'MON',
    stableToken: 'USDC',
    baseDec: TOKENS.MON.decimals,
    stableDec: TOKENS.USDC.decimals,
  },
  {
    pool: CBBTC_POOL,
    expectedImplementation: '0x2A53b21C7AE97656a0C69974E8003C5c324cb4cA',
    market: 'cbBTC/USDC',
    expectedX: TOKENS.USDC.address,
    expectedY: TOKENS.CBBTC.address,
    baseIsX: false,
    baseToken: 'CBBTC',
    stableToken: 'USDC',
    baseDec: TOKENS.CBBTC.decimals,
    stableDec: TOKENS.USDC.decimals,
  },
];

type ReadKey =
  | 'x'
  | 'y'
  | 'state'
  | 'reserveX'
  | 'reserveY'
  | 'concentrationK'
  | 'blockDelay'
  | 'paused'
  | 'blacklistFeeMultiplier'
  | 'whitelistProbe'
  | 'xDecimals'
  | 'yDecimals';

function registeredConfig(config: LunarbasePoolConfig): boolean {
  if (config.market === 'MON/USDC') return pairFor('MON', 'USDC')?.symbol === config.market;
  // cbBTC intentionally has its own pair symbol/basis; pairFor(BTC, USDC)
  // resolves the canonical WBTC market and must not be used here.
  return pairOf(config.market)?.symbol === config.market;
}

function implementationFromSlot(value: string | undefined): `0x${string}` | undefined {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return undefined;
  const address = `0x${value.slice(-40)}`.toLowerCase() as `0x${string}`;
  return address === ZERO ? undefined : address;
}

function readResult<T>(results: readonly any[], index: number | undefined): T | undefined {
  if (index === undefined) return undefined;
  const result = results[index];
  return result?.status === 'success' ? result.result as T : undefined;
}

async function readPoolsAtBlock(
  ctx: AdapterContext,
  configs: readonly LunarbasePoolConfig[],
  blockNumber: bigint,
  strict: boolean,
  onFailure: (config: LunarbasePoolConfig, reason: string) => void,
): Promise<LunarbaseCachedPool[]> {
  const calls: any[] = [];
  const indexes = new Map<string, Partial<Record<ReadKey, number>>>();
  const add = (config: LunarbasePoolConfig, key: ReadKey, abi: readonly unknown[], functionName: string, args?: readonly unknown[], address = config.pool) => {
    const index = calls.length;
    calls.push({ address, abi, functionName, ...(args ? { args } : {}) });
    const map = indexes.get(config.pool.toLowerCase()) ?? {};
    map[key] = index;
    indexes.set(config.pool.toLowerCase(), map);
  };

  for (const config of configs) {
    add(config, 'x', poolAbi, 'X');
    add(config, 'y', poolAbi, 'Y');
    add(config, 'state', poolAbi, 'state');
    add(config, 'reserveX', poolAbi, 'getXReserve');
    add(config, 'reserveY', poolAbi, 'getYReserve');
    add(config, 'concentrationK', poolAbi, 'concentrationK');
    add(config, 'blockDelay', poolAbi, 'blockDelay');
    add(config, 'paused', poolAbi, 'paused');
    add(config, 'blacklistFeeMultiplier', poolAbi, 'blacklistFeeMultiplier');
    add(config, 'whitelistProbe', poolAbi, 'isWhitelisted', [WHITELIST_PROBE]);
    if (config.expectedX.toLowerCase() !== ZERO) add(config, 'xDecimals', erc20Abi, 'decimals', undefined, config.expectedX);
    if (config.expectedY.toLowerCase() !== ZERO) add(config, 'yDecimals', erc20Abi, 'decimals', undefined, config.expectedY);
  }

  const [results, implementationSlots] = await Promise.all([
    ctx.client.multicall({ contracts: calls as any, allowFailure: true, blockNumber }),
    Promise.all(configs.map((config) => ctx.client.getStorageAt({ address: config.pool, slot: ERC1967_IMPLEMENTATION_SLOT, blockNumber }).catch(() => undefined))),
  ]);

  const found: LunarbaseCachedPool[] = [];
  const errors: string[] = [];
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const ix = indexes.get(config.pool.toLowerCase())!;
    try {
      if (!registeredConfig(config)) throw new Error(`market ${config.market} is not registered`);
      const x = String(readResult<string>(results, ix.x) ?? '').toLowerCase();
      const y = String(readResult<string>(results, ix.y) ?? '').toLowerCase();
      if (x !== config.expectedX.toLowerCase() || y !== config.expectedY.toLowerCase()) {
        throw new Error(`token order mismatch: X=${x || 'unreadable'} Y=${y || 'unreadable'}`);
      }
      const state = readResult<readonly [bigint, number, number, bigint]>(results, ix.state);
      const reserveX = readResult<bigint>(results, ix.reserveX);
      const reserveY = readResult<bigint>(results, ix.reserveY);
      const concentrationK = readResult<number>(results, ix.concentrationK);
      const blockDelay = readResult<bigint>(results, ix.blockDelay);
      const paused = readResult<boolean>(results, ix.paused);
      const blacklistFeeMultiplier = readResult<bigint>(results, ix.blacklistFeeMultiplier);
      const whitelistProbe = readResult<boolean>(results, ix.whitelistProbe);
      const implementation = implementationFromSlot(implementationSlots[i]);
      if (!state || reserveX === undefined || reserveY === undefined || concentrationK === undefined
        || blockDelay === undefined || paused === undefined || blacklistFeeMultiplier === undefined
        || whitelistProbe === undefined || !implementation) throw new Error('incomplete pinned snapshot');
      if (implementation.toLowerCase() !== config.expectedImplementation.toLowerCase()) {
        throw new Error(`unvalidated implementation ${implementation}`);
      }
      const xDecimals = x === ZERO ? 18 : readResult<number>(results, ix.xDecimals);
      const yDecimals = y === ZERO ? 18 : readResult<number>(results, ix.yDecimals);
      const expectedXDecimals = config.baseIsX ? config.baseDec : config.stableDec;
      const expectedYDecimals = config.baseIsX ? config.stableDec : config.baseDec;
      if (xDecimals !== expectedXDecimals || yDecimals !== expectedYDecimals) {
        throw new Error(`decimals mismatch: X=${String(xDecimals)} Y=${String(yDecimals)}`);
      }
      const [anchorPrice, feeAskX24, feeBidX24, latestUpdateBlock] = state;
      if (anchorPrice <= 0n || anchorPrice > MAX_U128) throw new Error('anchorPrice is outside the math package u128 range');
      if (!whitelistProbe) throw new Error(`production execution adapter ${WHITELIST_PROBE} is not whitelisted`);
      found.push({
        ...config,
        snapshot: {
          blockNumber,
          implementation,
          anchorPrice,
          feeAskX24: Number(feeAskX24),
          feeBidX24: Number(feeBidX24),
          latestUpdateBlock: BigInt(latestUpdateBlock),
          reserveX: BigInt(reserveX),
          reserveY: BigInt(reserveY),
          concentrationK: Number(concentrationK),
          blockDelay: BigInt(blockDelay),
          paused: Boolean(paused),
          blacklistFeeMultiplier: BigInt(blacklistFeeMultiplier),
          whitelistProbe: Boolean(whitelistProbe),
        },
        lastApplied: { blockNumber, logIndex: MAX_LOG_INDEX },
        needsRediscovery: false,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${config.market}: ${reason}`);
      onFailure(config, reason);
    }
  }
  if (strict && errors.length) throw new Error(`Lunarbase discovery failed (${errors.join('; ')})`);
  return found;
}

function newer(a: LogPosition, b: LogPosition): boolean {
  return a.blockNumber > b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex > b.logIndex);
}

function cloneRuntime(pool: LunarbaseCachedPool): LunarbaseCachedPool {
  return { ...pool, snapshot: { ...pool.snapshot }, lastApplied: { ...pool.lastApplied } };
}

function positionOf(log: any): LogPosition | undefined {
  if (log?.blockNumber === undefined || log?.logIndex === undefined) return undefined;
  try {
    return { blockNumber: BigInt(log.blockNumber), logIndex: Number(log.logIndex) };
  } catch {
    return undefined;
  }
}

export function applyLunarbaseStateLogs(pools: ReadonlyMap<string, LunarbaseCachedPool>, logs: readonly any[]): Map<string, LunarbaseCachedPool> {
  const staged = new Map<string, LunarbaseCachedPool>();
  for (const [address, pool] of pools) staged.set(address, cloneRuntime(pool));
  const ordered = [...logs].sort((a, b) => {
    const ap = positionOf(a), bp = positionOf(b);
    if (!ap || !bp) return 0;
    return ap.blockNumber === bp.blockNumber ? ap.logIndex - bp.logIndex : ap.blockNumber < bp.blockNumber ? -1 : 1;
  });

  for (const log of ordered) {
    const pool = staged.get(String(log?.address ?? '').toLowerCase());
    const position = positionOf(log);
    if (!pool || !position || !newer(position, pool.lastApplied)) continue;
    try {
      const args = log.args ?? {};
      switch (String(log.eventName ?? '')) {
        case 'StateUpdated': {
          const anchorPrice = BigInt(args.anchorPrice);
          if (anchorPrice <= 0n || anchorPrice > MAX_U128) throw new Error('invalid anchorPrice');
          pool.snapshot.anchorPrice = anchorPrice;
          pool.snapshot.feeAskX24 = Number(args.feeAskX24);
          pool.snapshot.feeBidX24 = Number(args.feeBidX24);
          pool.snapshot.latestUpdateBlock = position.blockNumber;
          break;
        }
        case 'Sync':
          pool.snapshot.reserveX = BigInt(args.reserveX);
          pool.snapshot.reserveY = BigInt(args.reserveY);
          break;
        case 'ConcentrationKSet':
          pool.snapshot.concentrationK = Number(args.concentrationK);
          break;
        case 'BlockDelaySet':
          pool.snapshot.blockDelay = BigInt(args.blockDelay);
          break;
        case 'Paused':
          pool.snapshot.paused = true;
          break;
        case 'Unpaused':
          pool.snapshot.paused = false;
          break;
        case 'BlacklistFeeMultiplierSet':
          pool.snapshot.blacklistFeeMultiplier = BigInt(args.multiplier);
          break;
        case 'WhitelistSet':
          if (String(args.account).toLowerCase() === WHITELIST_PROBE) pool.snapshot.whitelistProbe = Boolean(args.whitelisted);
          break;
        case 'Upgraded':
          pool.needsRediscovery = true;
          break;
        default:
          break;
      }
      pool.snapshot.blockNumber = position.blockNumber;
    } catch {
      // A single malformed log must not wedge the global block cursor. A pinned
      // refresh is authoritative and repairs any skipped cache field next tick.
    }
    pool.lastApplied = position;
  }
  return staged;
}

function quoteParams(snapshot: LunarbaseSnapshot, amountIn: bigint): QuoteParams {
  return {
    sqrtPriceX96: snapshot.anchorPrice.toString(),
    feeAskX24: snapshot.feeAskX24,
    feeBidX24: snapshot.feeBidX24,
    reserveX: snapshot.reserveX.toString(),
    reserveY: snapshot.reserveY.toString(),
    concentrationK: snapshot.concentrationK,
    amountIn: amountIn.toString(),
    feeMultiplier: '1',
  };
}

function feeBps(result: QuoteResult): number {
  const output = BigInt(result.amountOut), fee = BigInt(result.fee);
  const gross = output + fee;
  return gross > 0n ? Number(fee * 1_000_000_000n / gross) / 100_000 : 0;
}

export function lunarbaseQuoteDirection(pool: LunarbasePoolConfig, side: Side): 'quoteXToY' | 'quoteYToX' {
  const xToY = side === 'sell' ? pool.baseIsX : !pool.baseIsX;
  return xToY ? 'quoteXToY' : 'quoteYToX';
}

export function quoteLunarbaseLeg(pool: LunarbaseCachedPool, side: Side, amountIn: bigint): { px: number; feeBps: number } | undefined {
  if (amountIn <= 0n) return undefined;
  const result = lunarbaseQuoteDirection(pool, side) === 'quoteXToY'
    ? quoteXToY(quoteParams(pool.snapshot, amountIn))
    : quoteYToX(quoteParams(pool.snapshot, amountIn));
  const amountOut = BigInt(result.amountOut);
  if (amountOut <= 0n) return undefined;
  const inputDecimals = side === 'sell' ? pool.baseDec : pool.stableDec;
  const outputDecimals = side === 'sell' ? pool.stableDec : pool.baseDec;
  const input = fromUnits(amountIn, inputDecimals), output = fromUnits(amountOut, outputDecimals);
  if (input <= 0 || output <= 0) return undefined;
  return { px: side === 'sell' ? output / input : input / output, feeBps: feeBps(result) };
}

export function decodeLunarbaseSwap(log: any, config: LunarbasePoolConfig, ts: number): Fill | null {
  try {
    const args = log?.args;
    const txHash = String(log?.transactionHash ?? '');
    if (String(log?.address ?? '').toLowerCase() !== config.pool.toLowerCase()
      || !args || !/^0x[0-9a-fA-F]{64}$/.test(txHash)
      || log?.logIndex === undefined || log?.blockNumber === undefined) return null;
    const dx = BigInt(args.dx), dy = BigInt(args.dy);
    if (dx <= 0n || dy <= 0n) return null;
    const xToY = Boolean(args.xToY);
    const baseRaw = config.baseIsX ? dx : dy;
    const stableRaw = config.baseIsX ? dy : dx;
    const baseAmount = fromUnits(baseRaw, config.baseDec);
    const usd = fromUnits(stableRaw, config.stableDec);
    if (baseAmount <= 0 || usd <= 0) return null;
    const side: Side = xToY === config.baseIsX ? 'sell' : 'buy';
    return {
      id: `lunarbase-${txHash.toLowerCase()}-${Number(log.logIndex)}`,
      venueId: LUNARBASE_VENUE.id,
      market: config.market,
      side,
      category: 'UNKNOWN',
      usd,
      baseAmount,
      execPx: usd / baseAmount,
      txHash,
      to: shortHex(String(args.recipient ?? '0x')),
      pool: `lunarbase ${config.pool.slice(0, 8)}`,
      blockNumber: Number(log.blockNumber),
      ts,
      markoutsBps: [null, null, null, null, null],
    };
  } catch {
    return null;
  }
}

export function createLunarbaseAdapter(): VenueAdapter {
  const byAddress = new Map<string, LunarbaseCachedPool>();
  const byMarket = new Map<string, LunarbaseCachedPool>();
  const noted = new Set<string>();
  let discovered = false;
  const noteOnce = (ctx: AdapterContext, key: string, message: string) => {
    if (noted.has(key)) return;
    noted.add(key);
    ctx.log(message);
  };
  const recovered = (key: string) => noted.delete(key);

  return {
    venues: () => [LUNARBASE_VENUE],
    backfillFromUtc: '2026-04-30',

    async discover(ctx: AdapterContext) {
      const blockNumber = await ctx.client.getBlockNumber();
      const staged = await readPoolsAtBlock(ctx, LUNARBASE_POOLS, blockNumber, true, () => {});
      // Merge only after every configured production pool passed validation.
      for (const pool of staged) {
        byAddress.set(pool.pool.toLowerCase(), pool);
        byMarket.set(pool.market, pool);
      }
      discovered = true;
      ctx.log(`Lunarbase: ${staged.length} production pool(s), whitelist fee mode`);
    },

    async quote(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]> {
      if (!discovered) return [];
      let head: bigint;
      try {
        head = await ctx.client.getBlockNumber();
      } catch (error) {
        noteOnce(ctx, 'head', `Lunarbase quote unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }

      let current: LunarbaseCachedPool[];
      try {
        current = await readPoolsAtBlock(ctx, [...byMarket.values()], head, false, (config, reason) => {
          noteOnce(ctx, `snapshot:${config.pool}`, `Lunarbase ${config.market} quote unavailable: ${reason}`);
        });
      } catch (error) {
        noteOnce(ctx, 'snapshot', `Lunarbase quote refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
      recovered('head');
      recovered('snapshot');
      for (const pool of current) {
        recovered(`snapshot:${pool.pool}`);
        byAddress.set(pool.pool.toLowerCase(), pool);
        byMarket.set(pool.market, pool);
      }

      const rows: QuoteRow[] = [];
      const ts = Date.now();
      for (const pool of current) {
        const snapshot = pool.snapshot;
        if (snapshot.paused || !snapshot.whitelistProbe
          || head >= snapshot.latestUpdateBlock + snapshot.blockDelay) {
          noteOnce(ctx, `inactive:${pool.pool}`, `Lunarbase ${pool.market} quote hidden: ${snapshot.paused ? 'pool paused' : !snapshot.whitelistProbe ? 'whitelist route unavailable' : 'state stale'}`);
          continue;
        }
        recovered(`inactive:${pool.pool}`);
        const mid = ctx.pricer.pairMid(pool.market);
        if (!(mid > 0)) continue;
        for (const sizeUsd of sizesUsd) {
          let bid: ReturnType<typeof quoteLunarbaseLeg>, ask: ReturnType<typeof quoteLunarbaseLeg>;
          try {
            const sellIn = toUnits(ctx.pricer.tokenForUsd(pool.baseToken, sizeUsd), pool.baseDec);
            const buyIn = toUnits(sizeUsd, pool.stableDec);
            bid = quoteLunarbaseLeg(pool, 'sell', sellIn);
            ask = quoteLunarbaseLeg(pool, 'buy', buyIn);
          } catch (error) {
            noteOnce(ctx, `math:${pool.pool}`, `Lunarbase ${pool.market} math unavailable: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
          recovered(`math:${pool.pool}`);
          if (!bid && !ask) continue;
          const bidPx = bid?.px ?? 0, askPx = ask?.px ?? 0;
          const bidBps = bid ? (bidPx / mid - 1) * 1e4 : 0;
          const askBps = ask ? (askPx / mid - 1) * 1e4 : 0;
          const both = Boolean(bid && ask);
          rows.push({
            venueId: LUNARBASE_VENUE.id,
            market: pool.market,
            sizeUsd,
            bidPx,
            askPx,
            bidBps,
            askBps,
            spreadBps: both ? askBps - bidBps : 0,
            filledFull: both,
            oneSided: !both,
            feeBps: Math.max(bid?.feeBps ?? 0, ask?.feeBps ?? 0),
            ts,
          });
        }
      }
      return rows;
    },

    logSources() {
      if (!discovered) throw new Error('Lunarbase discovery unavailable');
      const addresses = [...byAddress.values()].map((pool) => pool.pool);
      return [
        { key: 'swap', address: addresses, events: [event('SwapExecuted')], kind: 'fills' as const },
        {
          key: 'state',
          address: addresses,
          events: ['StateUpdated', 'Sync', 'ConcentrationKSet', 'BlockDelaySet', 'WhitelistSet', 'BlacklistFeeMultiplierSet', 'Paused', 'Unpaused', 'Upgraded'].map(event),
          kind: 'state' as const,
        },
      ];
    },

    gasSources() {
      if (!discovered) throw new Error('Lunarbase discovery unavailable');
      return [
        { mode: 'logs' as const, address: [...byAddress.values()].map((pool) => pool.pool), topic0: CURRENT_STATE_TOPIC },
        { mode: 'logs' as const, address: MON_POOL, topic0: LEGACY_MON_STATE_TOPIC },
      ];
    },

    decode(_ctx: AdapterContext, logs: LogBundle, tsOf) {
      const staged = applyLunarbaseStateLogs(byAddress, logs.state ?? []);
      for (const [address, pool] of staged) {
        byAddress.set(address, pool);
        byMarket.set(pool.market, pool);
      }
      const fills: Fill[] = [];
      for (const log of logs.swap ?? []) {
        const pool = byAddress.get(String(log?.address ?? '').toLowerCase());
        if (!pool || log?.blockNumber === undefined) continue;
        const fill = decodeLunarbaseSwap(log, pool, tsOf(BigInt(log.blockNumber)));
        if (fill) fills.push(fill);
      }
      return fills;
    },
  };
}
