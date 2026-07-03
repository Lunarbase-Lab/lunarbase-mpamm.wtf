import type { QuoteRow } from '@shared';

/** Small shared numeric / formatting helpers used across the service. */

/**
 * Annotate each venue quote row with its realized cost vs the CEX-as-taker row
 * at the same market+size, sign-normalized so positive = on-chain executes worse
 * (spec §4.2 — the realized-vs-realized comparison). Mutates `venueRows`.
 */
export function annotateCex(venueRows: QuoteRow[], cexRows: QuoteRow[]): void {
  const cex = new Map<string, QuoteRow>();
  for (const b of cexRows) cex.set(`${b.market}|${b.sizeUsd}`, b);
  for (const r of venueRows) {
    const b = cex.get(`${r.market}|${r.sizeUsd}`);
    if (!b || b.askPx <= 0 || b.bidPx <= 0) continue;
    if (r.askPx > 0) r.cexAskBps = (r.askPx / b.askPx - 1) * 1e4; // buy base: pay more ⇒ worse
    if (r.bidPx > 0) r.cexBidBps = (b.bidPx / r.bidPx - 1) * 1e4; // sell base: get less ⇒ worse
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Linear-interpolated percentile of an unsorted array (p in [0,1]). */
export function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

/** Current UTC day as 'YYYY-MM-DD'. */
export function utcDay(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function shortHex(h: string, head = 4, tail = 4): string {
  if (!h.startsWith('0x') || h.length <= 2 + head + tail) return h;
  return h.slice(0, 2 + head) + '…' + h.slice(-tail);
}

/** scale a bigint raw token amount to a JS float by its decimals. */
export function fromUnits(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const val = Number(whole) + Number(frac) / Number(base);
  return neg ? -val : val;
}

/** convert a JS float notional to a raw bigint amount for `decimals`. */
export function toUnits(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  // route through a fixed-point string to avoid float drift on large decimals
  const s = value.toFixed(Math.min(decimals, 18));
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole + fracPadded);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let _seq = 0;
/** monotonically-increasing id with a prefix (for fills etc.). */
export function nextId(prefix: string): string {
  _seq = (_seq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${_seq.toString(36)}`;
}
