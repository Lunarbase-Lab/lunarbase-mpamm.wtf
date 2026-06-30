/** Numeric + string formatting helpers, ported from propAMM.dc.html's DCLogic. */

export function sgn(x: number, dp = 2): string {
  return (x >= 0 ? '+' : '') + x.toFixed(dp);
}

export function sizeLabel(s: number): string {
  return s >= 1000 ? '$' + s / 1000 + 'k' : '$' + s;
}

/** $1.23M / $4.5k / $12.34 (DCLogic.fmtUsd). */
export function fmtUsd(x: number): string {
  return x >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M'
    : x >= 1e3 ? '$' + (x / 1e3).toFixed(1) + 'k'
      : '$' + x.toFixed(2);
}

/** millions-scaled (DCLogic.f$) — input already in USD. */
export function fMillions(usd: number): string {
  const m = usd / 1e6;
  return m >= 1 ? '$' + m.toFixed(2) + 'M' : '$' + (m * 1000).toFixed(0) + 'k';
}

export function fmtAmt(x: number): string {
  return x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(2) + 'k' : x.toFixed(4);
}

export function pnlFmt(x: number): string {
  return (x >= 0 ? '+' : '−') + fmtUsd(Math.abs(x));
}

export function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

/** SVG path for a sparkline over [w,h] (DCLogic.sparkPath). */
export function sparkPath(arr: number[], w: number, h: number): string {
  if (!arr || arr.length < 2) return '';
  const mn = Math.min(...arr), mx = Math.max(...arr), rg = (mx - mn) || 1;
  return 'M' + arr.map((v, i) => (i / (arr.length - 1) * w).toFixed(1) + ',' + (h - (v - mn) / rg * h).toFixed(1)).join(' L');
}

export function humanAge(a: number): string {
  return a < 60 ? Math.round(a) + 's ago' : a < 3600 ? Math.round(a / 60) + 'm ago' : Math.round(a / 3600) + 'h ago';
}

/** HH:MM:SS.mmm UTC from an epoch-ms timestamp. */
export function clockMs(ts: number): string {
  return new Date(ts).toISOString().slice(11, 23);
}
export function clockSec(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(11, 19);
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Abbreviate a hash/address for display (idempotent — pre-shortened or short
 *  values pass through unchanged). Live decoders store full tx hashes. */
export function shortHex(h: string, head = 4, tail = 4): string {
  if (!h || h.includes('…') || h.length <= 2 + head + tail + 1) return h;
  return h.slice(0, 2 + head) + '…' + h.slice(-tail);
}
