import { describe, it, expect } from 'vitest';
import { decodeCloberTake, cloberTickToPrice, type CloberBook } from '../clober.js';

/**
 * Fixture-based decode tests — the pattern every adapter PR should follow
 * (docs/adapters.md → Tests). The fixture is a REAL log captured from Monad
 * (tx 0x42991909…, block 86,746,586) with its book config from the Clober
 * subgraph; the expected values were computed independently of the adapter
 * (plain math from tick/unit/decimals). No network — fixtures only.
 */

/** MON/USDC vault book (base = native MON, quote = USDC, unitSize 1). */
const BOOK: CloberBook = {
  bookId: 5954885684956363054050231031211743946744177791604395877538n,
  base: '0x0000000000000000000000000000000000000000',
  quote: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
  unitSize: 1n,
  baseSym: 'MON',
  quoteSym: 'USDC',
  isVault: true,
};

const TAKE_LOG = {
  args: {
    bookId: 5954885684956363054050231031211743946744177791604395877538n,
    user: '0x553037Bac82741e7CA05AfB48e8538996fD70ECa',
    tick: -313882,
    unit: 296730680n,
  },
  transactionHash: '0x42991909a8e6b88ef087bf0f108ec882b191b8f1d77241cc92a3d2381547e2e7',
  blockNumber: 86746586n,
  logIndex: 6,
};

const TS = 1_783_600_000_000;

describe('decodeCloberTake (real MON/USDC vault Take)', () => {
  const books = new Map([[String(BOOK.bookId), BOOK]]);
  const fill = decodeCloberTake(TAKE_LOG, books, TS)!;

  it('decodes the fill', () => {
    expect(fill).not.toBeNull();
  });

  it('quote leg is exact: usd = unit × unitSize / 10^6', () => {
    expect(fill.usd).toBeCloseTo(296.73068, 5);
  });

  it('realized price from the resting tick (1.0001^tick × 10^(baseDec−stableDec))', () => {
    expect(fill.execPx).toBeCloseTo(0.023386190540000906, 12);
  });

  it('base amount = usd / execPx', () => {
    expect(fill.baseAmount).toBeCloseTo(12688.28625561983, 6);
  });

  it('a Take on a base-side book consumes resting bids ⇒ taker sells', () => {
    expect(fill.side).toBe('sell');
    expect(fill.market).toBe('MON/USDC');
  });

  it('deterministic id (txHash:logIndex) so re-tails dedupe', () => {
    expect(fill.id).toBe('clb-0x42991909a8e6b88ef087bf0f108ec882b191b8f1d77241cc92a3d2381547e2e7-6');
    expect(fill.venueId).toBe('clober-vault');
    expect(fill.blockNumber).toBe(86746586);
    expect(fill.ts).toBe(TS);
  });

  it('markouts start null — the core ages them vs the reference', () => {
    expect(fill.markoutsBps).toEqual([null, null, null, null, null]);
  });

  it('an unknown book decodes to null, never a bad fill', () => {
    expect(decodeCloberTake(TAKE_LOG, new Map(), TS)).toBeNull();
  });
});

describe('cloberTickToPrice', () => {
  it('base-side book: price = 1.0001^tick scaled by decimals', () => {
    expect(cloberTickToPrice(-313882, true, 6, 18)).toBeCloseTo(0.023386190540000906, 12);
  });

  it('quote-side (mirror) book inverts the tick', () => {
    const px = cloberTickToPrice(313882, false, 6, 18);
    expect(px).toBeCloseTo(0.023386190540000906, 12);
  });

  it('generic over base decimals (WBTC = 8, not 18)', () => {
    // same tick, 8-decimal base: scale shrinks by 10^10
    expect(cloberTickToPrice(-313882, true, 6, 8)).toBeCloseTo(0.023386190540000906e-10, 20);
  });
});
