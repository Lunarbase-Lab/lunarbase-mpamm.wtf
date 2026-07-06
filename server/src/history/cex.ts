import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createWriteStream, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairOf, assetOf, TOKENS } from '@shared';
import { config } from '../config.js';

/**
 * HISTORICAL CEX price series — the data source for venue-lifetime markouts.
 *
 * Live markouts age against the in-memory mid ring; historical fills need the
 * pair's CEX mid at second precision at times long past. Both exchanges publish
 * exactly that, keylessly:
 *  - Bybit: monthly PUBLIC trade dumps (public.bybit.com/spot/<SYM>/<SYM>-YYYY-MM.csv.gz,
 *    `id,timestamp(ms),price,volume,side`) — reduced here to a per-second
 *    last-trade series (MON's base series; Bybit's kline API floors at 1m).
 *  - Binance: 1-SECOND klines via the geo-unrestricted data mirror (the base
 *    series for BTC/ETH).
 * Cross (USDCUSDT) and wrap (WBTCBTC) legs move ~bps per hour, so 1-minute
 * klines are ample for them (<0.1bp error over a 60s markout horizon).
 *
 * All lookups are CARRY-FORWARD with a staleness cap: `at(t)` returns the last
 * price at-or-before t, or null when no print exists within `staleMs` — a gap
 * yields a null markout (excluded), never a fabricated one.
 */

export interface StepSeries { at(t: number): number | null }

const STALE_BASE_MS = 120_000;  // base leg: trades/1s-klines — 2min gap ⇒ null
const STALE_SLOW_MS = 30 * 60_000; // cross/wrap legs: 1m klines, slow-moving

function makeSeries(ts: number[], px: number[], staleMs: number): StepSeries {
  return {
    at(t: number): number | null {
      // binary search: last index with ts[i] <= t
      let lo = 0, hi = ts.length - 1, ans = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      if (ans < 0 || t - ts[ans] > staleMs) return null;
      return px[ans];
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchJson(url: string): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
      return await r.json();
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

/** Binance klines (data mirror) → StepSeries of closes stamped at close time. */
export async function binanceKlineSeries(symbol: string, interval: '1s' | '1m', fromMs: number, toMs: number): Promise<StepSeries> {
  const ts: number[] = [], px: number[] = [];
  let start = fromMs;
  while (start < toMs) {
    const rows: any[] = await fetchJson(
      `${config.binanceRest}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&endTime=${toMs}&limit=1000`);
    if (!rows.length) break;
    for (const k of rows) { ts.push(Number(k[6])); px.push(parseFloat(k[4])); } // closeTime, close
    const lastOpen = Number(rows[rows.length - 1][0]);
    if (lastOpen <= start && rows.length < 1000) break;
    start = lastOpen + (interval === '1s' ? 1_000 : 60_000);
    if (rows.length < 1000 && start < toMs) break; // exchange has no more data in range
    await sleep(config.backfillPaceMs);
  }
  return makeSeries(ts, px, interval === '1s' ? STALE_BASE_MS : STALE_SLOW_MS);
}

/** Bybit klines (1-minute) → StepSeries of closes stamped at close time (cross leg).
 *  NB Bybit returns the NEWEST 1000 candles of [start,end] (newest-first), so
 *  pagination walks BACKWARD by lowering `end` — a forward walk collects only
 *  the tail of the range and silently starves earlier hours. Errors arrive as
 *  retCode in HTTP-200 envelopes; throw on them so the caller defers instead of
 *  treating an error as an empty (all-null) series. */
export async function bybitKlineSeries(symbol: string, fromMs: number, toMs: number): Promise<StepSeries> {
  const pts: Array<[number, number]> = [];
  let end = toMs;
  while (end > fromMs) {
    const j = await fetchJson(
      `${config.bybitRest}/v5/market/kline?category=spot&symbol=${symbol}&interval=1&start=${fromMs}&end=${end}&limit=1000`);
    if (j?.retCode !== 0) throw new Error(`bybit kline ${symbol}: ${j?.retCode} ${j?.retMsg ?? ''}`);
    const rows: any[] = j?.result?.list ?? [];
    if (!rows.length) break;
    for (const r of rows) pts.push([Number(r[0]) + 60_000, parseFloat(r[4])]); // close @ close time
    const oldestStart = Number(rows[rows.length - 1][0]);
    if (oldestStart <= fromMs) break;
    end = oldestStart - 1;
    await sleep(config.backfillPaceMs);
  }
  pts.sort((a, b) => a[0] - b[0]);
  return makeSeries(pts.map((p) => p[0]), pts.map((p) => p[1]), STALE_SLOW_MS);
}

// ── Bybit monthly trade dumps ────────────────────────────────────────────────

const dumpDir = () => {
  const d = process.env.HIST_CACHE_DIR ?? join(tmpdir(), 'mpamm-cex-dumps');
  mkdirSync(d, { recursive: true });
  return d;
};

const bybitDumpUrl = (symbol: string, month: string) => `https://public.bybit.com/spot/${symbol}/${symbol}-${month}.csv.gz`;

/** true when the month's dump is published (HEAD, no body) — lets a multi-month
 *  request fail fast BEFORE downloading any dump: without this, every boot
 *  re-downloaded a full month (~10²MB, tmp cache is wiped per deploy) only to
 *  defer on the NEXT month's 404. Non-404 probe failures return true (the GET
 *  decides — a flaky HEAD must not fabricate an "unpublished" verdict). */
async function bybitDumpExists(symbol: string, month: string): Promise<boolean> {
  if (existsSync(join(dumpDir(), `${symbol}-${month}.csv.gz`))) return true;
  try {
    const r = await fetch(bybitDumpUrl(symbol, month), { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    return r.status !== 404;
  } catch {
    return true;
  }
}

/** Download (once) a Bybit monthly spot trade dump; returns local path or null (404 = month not published). */
async function bybitDumpFile(symbol: string, month: string /* YYYY-MM */): Promise<string | null> {
  const path = join(dumpDir(), `${symbol}-${month}.csv.gz`);
  if (existsSync(path)) return path;
  const url = bybitDumpUrl(symbol, month);
  // generous timeout: it covers the WHOLE body stream (a ~12MB file on a slow
  // link can exceed 2min), and pipeline() propagates every stream error into
  // the awaited promise (a bare .pipe() left source errors unhandled → crash).
  const r = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (r.status === 404) return null;
  if (!r.ok || !r.body) throw new Error(`bybit dump ${r.status} for ${symbol} ${month}`);
  const { pipeline } = await import('node:stream/promises');
  const { renameSync, rmSync } = await import('node:fs');
  try {
    await pipeline(Readable.fromWeb(r.body as any), createWriteStream(path + '.part'));
  } catch (e) {
    rmSync(path + '.part', { force: true }); // never leave a truncated cache file
    throw e;
  }
  renameSync(path + '.part', path);
  return path;
}

/** Per-second last-trade series for [fromMs, toMs) from Bybit monthly dumps
 *  (spans up to two months). Returns null when a needed month isn't published
 *  yet — the caller defers those days to a later run rather than fabricating. */
export async function bybitTradeSeries(symbol: string, fromMs: number, toMs: number): Promise<StepSeries | null> {
  const months = new Set<string>();
  for (let t = fromMs; t < toMs + 86_400_000; t += 86_400_000) months.add(new Date(t).toISOString().slice(0, 7));
  months.add(new Date(toMs).toISOString().slice(0, 7));
  // fail fast: probe every needed month before downloading ANY of them.
  for (const month of [...months].sort()) {
    if (!(await bybitDumpExists(symbol, month))) return null;
  }
  const ts: number[] = [], px: number[] = [];
  for (const month of [...months].sort()) {
    const file = await bybitDumpFile(symbol, month);
    if (!file) return null; // month not published yet
    await new Promise<void>((resolve, reject) => {
      // wire EVERY stage's error into the promise — readline does not forward
      // input-stream errors, and an unhandled 'error' event kills the process.
      const raw = createReadStream(file);
      const gz = createGunzip();
      raw.on('error', reject);
      gz.on('error', reject);
      const rl = createInterface({ input: raw.pipe(gz), crlfDelay: Infinity });
      let lastSec = -1;
      rl.on('line', (line) => {
        // id,timestamp(ms),price,volume,side
        const c1 = line.indexOf(','); if (c1 < 0) return;
        const c2 = line.indexOf(',', c1 + 1); if (c2 < 0) return;
        const t = Number(line.slice(c1 + 1, c2));
        if (!Number.isFinite(t) || t < fromMs || t >= toMs) return;
        const c3 = line.indexOf(',', c2 + 1);
        const p = parseFloat(line.slice(c2 + 1, c3 < 0 ? undefined : c3));
        if (!(p > 0)) return;
        const sec = Math.floor(t / 1000);
        if (sec === lastSec) { ts[ts.length - 1] = t; px[px.length - 1] = p; } // keep the LAST trade of the second
        else { lastSec = sec; ts.push(t); px.push(p); }
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });
  }
  if (!ts.length) return null;
  return makeSeries(ts, px, STALE_BASE_MS);
}

// ── pair-terms mid series (base × wrap ÷ cross — same construction as live) ──

/**
 * The pair's CEX mid at second precision over [fromMs, toMs), in the PAIR'S OWN
 * terms — identical construction to the live ReferenceRegistry (§5.5), sourced
 * from the exchanges' historical archives. Returns null when a required source
 * isn't available yet (e.g. the current month's Bybit dump).
 */
export async function pairMidSeries(market: string, fromMs: number, toMs: number): Promise<StepSeries | null> {
  const pair = pairOf(market);
  const asset = pair ? assetOf(pair.base) : undefined;
  if (!pair || !asset) return null;
  const pad = STALE_SLOW_MS; // lead-in so carry-forward has a value at fromMs
  const crossSym = TOKENS[pair.quote]?.usdtCross;

  let base: StepSeries | null;
  let cross: StepSeries | null = null;
  const wrapSym = asset.wrapBasisSymbol;
  let wrap: StepSeries | null = null;

  if (asset.cex === 'binance') {
    base = await binanceKlineSeries(asset.cexSymbol, '1s', fromMs - STALE_BASE_MS, toMs);
    if (crossSym) cross = await binanceKlineSeries(crossSym, '1m', fromMs - pad, toMs);
    if (wrapSym) wrap = await binanceKlineSeries(wrapSym, '1m', fromMs - pad, toMs);
  } else {
    base = await bybitTradeSeries(asset.cexSymbol, fromMs - STALE_BASE_MS, toMs);
    if (base === null) return null; // dump month not published yet
    if (crossSym) {
      // api.bybit.com REST geo-blocks some server IPs (403 from Render US —
      // observed in prod; the dump host public.bybit.com is NOT blocked). The
      // same stable/stable cross trades on Binance within fractions of a bp,
      // so fall back to the geo-unrestricted Binance mirror.
      try { cross = await bybitKlineSeries(crossSym, fromMs - pad, toMs); }
      catch { cross = await binanceKlineSeries(crossSym, '1m', fromMs - pad, toMs); }
    }
  }
  if (!base) return null;

  return {
    at(t: number): number | null {
      const b = base!.at(t);
      if (b == null) return null;
      let v = b;
      if (wrapSym) { const w = wrap?.at(t); if (w == null) return null; v *= w; }
      if (crossSym) { const c = cross?.at(t); if (c == null) return null; v /= c; }
      return v;
    },
  };
}
