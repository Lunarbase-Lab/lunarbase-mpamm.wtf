import { describe, expect, it } from 'vitest';
import {
  LUNARBASE_POOLS,
  applyLunarbaseStateLogs,
  createLunarbaseAdapter,
  decodeLunarbaseSwap,
  lunarbaseQuoteDirection,
  quoteLunarbaseXToY,
  quoteLunarbaseYToX,
  quoteLunarbaseLeg,
  type LunarbaseCachedPool,
  type LunarbasePmmParams,
} from '../lunarbase.js';

/**
 * Real Monad SwapExecuted fixtures covering both token orders and directions.
 * Expected amounts are independently scaled from raw event integers; no RPC is
 * used in tests. `recipient` is not the caller and cannot prove attribution.
 */

const TS = 1_783_679_000_000;
const [MON_POOL, CBBTC_POOL] = LUNARBASE_POOLS;

const MON_SELL = {
  address: MON_POOL.pool.toLowerCase(),
  args: {
    recipient: '0xfb78Fcae443eB423b59B8C186518c5dF94416344',
    xToY: true,
    dx: 9_923_973_000_000_000_000_000n,
    dy: 225_999_389n,
    fee: 31_566n,
  },
  blockNumber: 86_807_396n,
  transactionHash: '0x75879d7d4fb3fc6380e1ca16404765853d4d693adaebb0d1f7d5e524daad342c',
  logIndex: 102,
};

const MON_BUY = {
  address: MON_POOL.pool.toLowerCase(),
  args: {
    recipient: '0xfb78Fcae443eB423b59B8C186518c5dF94416344',
    xToY: false,
    dx: 14_593_103_441_529_868_288_115n,
    dy: 328_865_790n,
    fee: 12_626_737_983_444_994_440n,
  },
  blockNumber: 86_798_698n,
  transactionHash: '0x5cbc98f4a7aa9abe704656a7dbce129bc189ecb611d97988666cc2af0b271338',
  logIndex: 17,
};

const CBBTC_BUY = {
  address: CBBTC_POOL.pool.toLowerCase(),
  args: {
    recipient: '0xfb78Fcae443eB423b59B8C186518c5dF94416344',
    xToY: true,
    dx: 7_302_194n,
    dy: 11_618n,
    fee: 1n,
  },
  blockNumber: 86_575_884n,
  transactionHash: '0x95b53137ded11d931850be0de60fc00d0ed62a760e666f2c35d766bda4d518e8',
  logIndex: 149,
};

const CBBTC_SELL = {
  address: CBBTC_POOL.pool.toLowerCase(),
  args: {
    recipient: '0xfb78Fcae443eB423b59B8C186518c5dF94416344',
    xToY: false,
    dx: 30_061_294n,
    dy: 48_000n,
    fee: 51_879n,
  },
  blockNumber: 85_972_529n,
  transactionHash: '0x6c6bd9ed3e8168a3cb7734a90597ca92127fb8b569ca6020ad1827b820f02044',
  logIndex: 88,
};

/** Real whitelisted eth_call results at fixed Monad blocks. Each vector locks
 * the raw PMM return values — output, pNext and fee — rather than a rounded UI
 * price. This is the reviewable parity contract for the inline bigint port. */
const MON_PMM_AT_86814203: LunarbasePmmParams = {
  sqrtPriceX96: 11_933_797_043_800_708_743_168n,
  feeAskX24: 1_582,
  feeBidX24: 4_441,
  reserveX: 269_345_554_971_310_134_626_149n,
  reserveY: 4_991_698_028n,
  concentrationK: 400,
};
const CBBTC_PMM_AT_86814205: LunarbasePmmParams = {
  sqrtPriceX96: 3_121_435_775_563_248_879_477_456_896n,
  feeAskX24: 40_453,
  feeBidX24: 369,
  reserveX: 277_668_751n,
  reserveY: 38_585n,
  concentrationK: 16_000,
};

function expectRawQuote(
  result: ReturnType<typeof quoteLunarbaseXToY>,
  amountOut: bigint,
  sqrtPriceNext: bigint,
  fee: bigint,
) {
  expect(result).toEqual({ amountOut, sqrtPriceNext, fee });
}

describe('Lunarbase inline PMM parity (real whitelisted contract calls)', () => {
  it('matches MON at block 86814203 for both directions and sizes', () => {
    expectRawQuote(quoteLunarbaseXToY(MON_PMM_AT_86814203, 1n * 10n ** 18n), 22_682n, 11_933_797_043_797_475_721_804n, 6n);
    expectRawQuote(quoteLunarbaseXToY(MON_PMM_AT_86814203, 100n * 10n ** 18n), 2_268_209n, 11_933_797_043_477_406_606_775n, 600n);
    expectRawQuote(quoteLunarbaseYToX(MON_PMM_AT_86814203, 1n * 10n ** 6n), 44_071_813_216_552_635_073n, 11_933_797_043_917_108_161_803n, 4_156_123_608_120_341n);
    expectRawQuote(quoteLunarbaseYToX(MON_PMM_AT_86814203, 100n * 10n ** 6n), 4_407_181_033_704_561_620_515n, 11_933_797_823_676_813_600_589n, 415_612_333_657_292_265n);
  });

  it('matches cbBTC at block 86814205, including the rejected-size path', () => {
    expectRawQuote(quoteLunarbaseXToY(CBBTC_PMM_AT_86814205, 1n * 10n ** 6n), 1_552n, 3_121_433_096_096_964_440_252_808_149n, 0n);
    expectRawQuote(quoteLunarbaseXToY(CBBTC_PMM_AT_86814205, 100n * 10n ** 6n), 0n, 3_121_435_775_563_248_879_477_456_896n, 0n);
    expectRawQuote(quoteLunarbaseYToX(CBBTC_PMM_AT_86814205, 100_000n), 62_913_174n, 3_188_707_897_884_366_635_740_212_998n, 152_062n);
    expectRawQuote(quoteLunarbaseYToX(CBBTC_PMM_AT_86814205, 1_000_000n), 0n, 3_121_435_775_563_248_879_477_456_896n, 0n);
  });

  it('retains the integer-square-root rounding boundary from the PMM fuzz suite', () => {
    const params: LunarbasePmmParams = {
      sqrtPriceX96: 79_228_162_514_264_337_593_547n,
      feeAskX24: 1_267,
      feeBidX24: 0,
      reserveX: 1_000_000_000_024_439n,
      reserveY: 0n,
      concentrationK: 59_617,
    };
    expectRawQuote(quoteLunarbaseYToX(params, 197n), 184_607_377_735_615n, 84_540_333_700_582_260_956_920n, 13_942_433_157n);
  });
});

describe('decodeLunarbaseSwap (real Monad fixtures)', () => {
  it('decodes MON X→Y as a base sell with 18/6 decimals', () => {
    const fill = decodeLunarbaseSwap(MON_SELL, MON_POOL, TS)!;
    expect(fill.side).toBe('sell');
    expect(fill.market).toBe('MON/USDC');
    expect(fill.baseAmount).toBeCloseTo(9_923.973, 12);
    expect(fill.usd).toBeCloseTo(225.999389, 9);
    expect(fill.execPx).toBeCloseTo(0.022773075763104153, 15);
    expect(fill.id).toBe(`lunarbase-${MON_SELL.transactionHash}-102`);
  });

  it('decodes MON Y→X as a base buy', () => {
    const fill = decodeLunarbaseSwap(MON_BUY, MON_POOL, TS)!;
    expect(fill.side).toBe('buy');
    expect(fill.baseAmount).toBeCloseTo(14_593.103441529868, 9);
    expect(fill.usd).toBeCloseTo(328.86579, 9);
    expect(fill.execPx).toBeCloseTo(0.022535699230644482, 15);
    expect(fill.id).toBe(`lunarbase-${MON_BUY.transactionHash}-17`);
  });

  it('decodes cbBTC X→Y as a base buy with 6/8 decimals', () => {
    const fill = decodeLunarbaseSwap(CBBTC_BUY, CBBTC_POOL, TS)!;
    expect(fill.side).toBe('buy');
    expect(fill.market).toBe('cbBTC/USDC');
    expect(fill.baseAmount).toBeCloseTo(0.00011618, 12);
    expect(fill.usd).toBeCloseTo(7.302194, 9);
    expect(fill.execPx).toBeCloseTo(62_852.41866069892, 8);
    expect(fill.id).toBe(`lunarbase-${CBBTC_BUY.transactionHash}-149`);
  });

  it('decodes cbBTC Y→X as a base sell', () => {
    const fill = decodeLunarbaseSwap(CBBTC_SELL, CBBTC_POOL, TS)!;
    expect(fill.side).toBe('sell');
    expect(fill.baseAmount).toBeCloseTo(0.00048, 12);
    expect(fill.usd).toBeCloseTo(30.061294, 9);
    expect(fill.execPx).toBeCloseTo(62_627.69583333333, 8);
    expect(fill.id).toBe(`lunarbase-${CBBTC_SELL.transactionHash}-88`);
  });

  it('does not invent attribution from the recipient field', () => {
    const fill = decodeLunarbaseSwap(MON_SELL, MON_POOL, TS)!;
    expect(fill.category).toBe('UNKNOWN');
    expect(fill.to).toBe('0xfb78…6344');
    expect(fill.markoutsBps).toEqual([null, null, null, null, null]);
  });

  it('skips unknown pools and malformed logs locally', () => {
    expect(decodeLunarbaseSwap({ ...MON_SELL, address: '0x0000000000000000000000000000000000000001' }, MON_POOL, TS)).toBeNull();
    expect(decodeLunarbaseSwap({ ...MON_SELL, args: { xToY: true } }, MON_POOL, TS)).toBeNull();
  });
});

function cachedPool(): LunarbaseCachedPool {
  return {
    ...MON_POOL,
    baseDec: 0,
    stableDec: 0,
    snapshot: {
      blockNumber: 100n,
      implementation: '0x0000000000000000000000000000000000000010',
      anchorPrice: 1n << 96n,
      feeAskX24: 0,
      feeBidX24: 0,
      latestUpdateBlock: 100n,
      reserveX: 1_000_000n,
      reserveY: 1_000_000n,
      concentrationK: 4_000,
      blockDelay: 10n,
      paused: false,
      blacklistFeeMultiplier: 100n,
      whitelistProbe: true,
    },
    lastApplied: { blockNumber: 100n, logIndex: Number.MAX_SAFE_INTEGER },
    needsRediscovery: false,
  };
}

describe('Lunarbase monotonic state cache', () => {
  it('applies an absolute Sync once and reserve-only changes move the quote', () => {
    const initial = cachedPool();
    const before = quoteLunarbaseLeg(initial, 'sell', 100_000n)!.px;
    const sync = {
      address: initial.pool,
      eventName: 'Sync',
      args: { reserveX: 1_000_000n, reserveY: 2_000_000n },
      blockNumber: 101n,
      logIndex: 2,
    };
    const once = applyLunarbaseStateLogs(new Map([[initial.pool.toLowerCase(), initial]]), [sync]);
    const updated = once.get(initial.pool.toLowerCase())!;
    const after = quoteLunarbaseLeg(updated, 'sell', 100_000n)!.px;
    expect(after).not.toBe(before);
    expect(updated.snapshot.reserveY).toBe(2_000_000n);
    expect(initial.snapshot.reserveY).toBe(1_000_000n); // staged, then committed

    const twice = applyLunarbaseStateLogs(once, [sync]);
    expect(twice.get(initial.pool.toLowerCase())!.snapshot).toEqual(updated.snapshot);
  });

  it('never lets historical state logs roll a pinned snapshot backwards', () => {
    const initial = cachedPool();
    const oldSync = {
      address: initial.pool,
      eventName: 'Sync',
      args: { reserveX: 1n, reserveY: 1n },
      blockNumber: 99n,
      logIndex: 9,
    };
    const staged = applyLunarbaseStateLogs(new Map([[initial.pool.toLowerCase(), initial]]), [oldSync]);
    expect(staged.get(initial.pool.toLowerCase())!.snapshot.reserveX).toBe(1_000_000n);
  });

  it('sorts state events and invalidates the cache on an upgrade', () => {
    const initial = cachedPool();
    const logs = [
      { address: initial.pool, eventName: 'Upgraded', args: {}, blockNumber: 104n, logIndex: 4 },
      { address: initial.pool, eventName: 'Paused', args: {}, blockNumber: 103n, logIndex: 3 },
      {
        address: initial.pool,
        eventName: 'StateUpdated',
        args: { anchorPrice: (1n << 96n) + 7n, feeAskX24: 10, feeBidX24: 20 },
        blockNumber: 102n,
        logIndex: 2,
      },
    ];
    const staged = applyLunarbaseStateLogs(new Map([[initial.pool.toLowerCase(), initial]]), logs);
    const updated = staged.get(initial.pool.toLowerCase())!;
    expect(updated.snapshot.anchorPrice).toBe((1n << 96n) + 7n);
    expect(updated.snapshot.feeAskX24).toBe(10);
    expect(updated.snapshot.feeBidX24).toBe(20);
    expect(updated.snapshot.paused).toBe(true);
    expect(updated.needsRediscovery).toBe(true);
    expect(updated.lastApplied).toEqual({ blockNumber: 104n, logIndex: 4 });
  });
});

describe('Lunarbase per-pool discovery quarantine', () => {
  it('keeps validated pools tailing when another proxy has an unknown implementation', async () => {
    const [mon, cbbtc] = LUNARBASE_POOLS;
    const slotFor = (address: string) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
    const client = {
      getBlockNumber: async () => 100n,
      getStorageAt: async ({ address }: { address: string }) =>
        slotFor(address.toLowerCase() === mon.pool.toLowerCase() ? '0x0000000000000000000000000000000000000001' : cbbtc.expectedImplementation),
      multicall: async ({ contracts }: { contracts: Array<{ address: string; functionName: string }> }) => contracts.map((call) => {
        const pool = LUNARBASE_POOLS.find((candidate) => candidate.pool.toLowerCase() === call.address.toLowerCase());
        switch (call.functionName) {
          case 'X': return { status: 'success', result: pool!.expectedX };
          case 'Y': return { status: 'success', result: pool!.expectedY };
          case 'state': return { status: 'success', result: [1n << 96n, 100, 100, 100n] };
          case 'getXReserve': case 'getYReserve': return { status: 'success', result: 1_000_000n };
          case 'concentrationK': return { status: 'success', result: 4_000 };
          case 'blockDelay': return { status: 'success', result: 10n };
          case 'paused': return { status: 'success', result: false };
          case 'blacklistFeeMultiplier': return { status: 'success', result: 100n };
          case 'isWhitelisted': return { status: 'success', result: true };
          case 'decimals': return { status: 'success', result: call.address.toLowerCase() === cbbtc.expectedY.toLowerCase() ? 8 : 6 };
          default: throw new Error(`unexpected read ${call.functionName}`);
        }
      }),
    };
    const notes: string[] = [];
    const adapter = createLunarbaseAdapter();
    await adapter.discover({ client, log: (message: string) => notes.push(message) } as any);

    const sources = adapter.logSources();
    expect(sources).toHaveLength(2);
    expect(sources[0].address).toEqual([cbbtc.pool]);
    expect(adapter.gasSources!()[0].address).toEqual([cbbtc.pool]);
    expect(notes.some((message) => message.includes('MON/USDC quarantined: unvalidated implementation'))).toBe(true);
  });
});

describe('Lunarbase local quote mapping', () => {
  it('maps both token orders to the correct PMM direction', () => {
    expect(lunarbaseQuoteDirection(MON_POOL, 'sell')).toBe('quoteXToY');
    expect(lunarbaseQuoteDirection(MON_POOL, 'buy')).toBe('quoteYToX');
    expect(lunarbaseQuoteDirection(CBBTC_POOL, 'sell')).toBe('quoteYToX');
    expect(lunarbaseQuoteDirection(CBBTC_POOL, 'buy')).toBe('quoteXToY');
  });

});
