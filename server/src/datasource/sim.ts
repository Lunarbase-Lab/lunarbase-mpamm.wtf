import { BaseSource } from './index.js';
import {
  MARKETS, SIZES_USD, MARKOUT_HORIZONS, HISTORY_START_UTC,
  type DataSourceMode, type MarketState, type QuoteSnapshot, type QuoteRow,
  type Fill, type DailyVolume, type Venue, type Protocol, type Scope, type Side, type FillCategory,
} from '@shared';
import { config } from '../config.js';
import { clamp, utcDay, nextId, annotateCex } from '../util.js';

/**
 * SimDataSource — a server-side port of the design's DCLogic simulation
 * (propAMM.dc.html). Random-walk quotes per venue, a seeded daily-volume
 * history that advances live, and a fill tape with markouts. Produces the exact
 * same contract the live source does, so the frontend is identical.
 */

const VEN: Venue[] = ['LFJ', 'Clober', 'Vault', 'Bybit'];
const SLIP: Record<Venue, number> = { LFJ: 2.0, Clober: 3.6, Vault: 1.0, Bybit: 0.3 };
const PAIR_MULT: Record<string, number> = { 'MON/USDC': 1.0, 'MON/USDT0': 1.15, 'MON/AUSD': 1.4, 'MON/USD1': 1.6 };
const BASE_MON = 0.01928;

interface SimFill extends Fill { _proto: 'LFJ' | 'Clober' | 'Vault'; bornMs: number; }

function rnd(): number { return Math.random() * 2 - 1; }
function wpick<T>(a: T[], w: number[]): T {
  const r = Math.random() * w.reduce((x, y) => x + y, 0);
  let c = 0;
  for (let i = 0; i < a.length; i++) { c += w[i]; if (r < c) return a[i]; }
  return a[a.length - 1];
}
function rhex(n: number): string {
  let s = ''; const c = '0123456789abcdef';
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * 16)];
  return s;
}
function txS(): string { return '0x' + rhex(4) + '…' + rhex(4); }

export class SimDataSource extends BaseSource {
  readonly mode: DataSourceMode = 'sim';

  private mon = BASE_MON;
  private chg = 2.3;
  private block = 84_500_000;
  private offset: Record<Venue, number> = { LFJ: -1.0, Clober: -1.6, Vault: -0.2, Bybit: 0 };
  private half: Record<Venue, number> = { LFJ: 1.8, Clober: 2.4, Vault: 1.0, Bybit: 0.15 };
  private days: DailyVolume[] = [];
  private totalSwaps = 0;
  private fills: SimFill[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private pools: Record<string, string> = {};
  private addrs: string[] = [];
  private routers = ['Uniswap Universal Router', 'KyberSwap: Meta Aggregation', 'Relay: Approval Proxy V3', '1inch v6 Router', 'Odos Router v2'];

  async start(): Promise<void> {
    this.initEntities();
    // warm the random walk so opening quotes look settled (design: 220 steps)
    for (let i = 0; i < 220; i++) this.mutate();
    this.seedHistory();
    this.seedFills();
    this.timer = setInterval(() => this.tick(), config.quoteIntervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  // ── reads ─────────────────────────────────────────────────────────────────
  getState(): MarketState {
    return {
      chainId: 143, block: this.block, monUsd: this.mon, monChangePct: this.chg,
      takerBps: config.takerBps, markets: [...MARKETS], sizesUsd: [...SIZES_USD],
      quoteCadenceMs: config.quoteIntervalMs, source: 'sim',
      notes: ['simulated data — set DATA_SOURCE=live for on-chain quotes'],
    };
  }
  getQuotes(): QuoteSnapshot { return { block: this.block, monUsd: this.mon, ts: Date.now(), rows: this.buildMatrix() }; }
  getFills(): Fill[] { return this.fills.map(stripFill); }
  getVolume(): DailyVolume[] { return this.days.map((d) => ({ ...d })); }

  // ── quote model (DCLogic.quoteAt) ──────────────────────────────────────────
  private quoteAt(v: Venue, market: string, size: number): { bidBps: number; askBps: number; bidPx: number; askPx: number } {
    const pm = PAIR_MULT[market] ?? 1;
    const sizeStep = Math.log10(size / 100);
    const hsz = this.half[v] * pm + SLIP[v] * sizeStep + (v === 'Bybit' ? config.takerBps : 0);
    const o = this.offset[v];
    const bid = o - hsz, ask = o + hsz;
    return { bidBps: bid, askBps: ask, bidPx: this.mon * (1 + bid / 1e4), askPx: this.mon * (1 + ask / 1e4) };
  }

  private buildMatrix(): QuoteRow[] {
    const ts = Date.now();
    const rows: QuoteRow[] = [];
    for (const v of VEN) {
      for (const market of MARKETS) {
        for (const size of SIZES_USD) {
          const q = this.quoteAt(v, market, size);
          const sizeStep = Math.log10(size / 100);
          rows.push({
            venue: v, market, sizeUsd: size,
            bidBps: q.bidBps, askBps: q.askBps, bidPx: q.bidPx, askPx: q.askPx,
            spreadBps: q.askBps - q.bidBps,
            filledFull: size < 100000 || v === 'Bybit',
            feeBps: v === 'LFJ' ? 0.3 + 0.04 * sizeStep : 0,
            ts,
          });
        }
      }
    }
    annotateCex(rows.filter((r) => r.venue !== 'Bybit'), rows.filter((r) => r.venue === 'Bybit'));
    return rows;
  }

  private mutate(): void {
    this.mon *= 1 + rnd() * 0.0006;
    this.mon = clamp(this.mon, BASE_MON * 0.95, BASE_MON * 1.05);
    this.chg = clamp(this.chg + rnd() * 0.05, -8, 8);
    for (const v of ['LFJ', 'Clober', 'Vault'] as Venue[]) {
      this.offset[v] += rnd() * 0.15; this.half[v] += rnd() * 0.08;
      if (Math.random() < 0.05) { this.half[v] += rnd() * 0.8; this.offset[v] += rnd() * 0.6; }
      this.offset[v] = clamp(this.offset[v], -6, 6);
      this.half[v] = clamp(this.half[v], 0.5, 13);
    }
    this.half.Bybit = 0.12 + Math.random() * 0.08;
  }

  // ── volume history (DCLogic.seedHistory / bumpVolume) ───────────────────────
  private seedHistory(): void {
    const start = Date.parse(HISTORY_START_UTC + 'T00:00:00Z');
    const today = Date.parse(utcDay() + 'T00:00:00Z');
    const n = Math.max(2, Math.round((today - start) / 86_400_000) + 1);
    let swaps = 0;
    for (let i = 0; i < n; i++) {
      const dt = new Date(start + i * 86_400_000);
      const ramp = Math.min(1, i / 20);
      let total = 0.06 + ramp * ramp * (3.2 + Math.random() * 1.8);
      if (Math.random() < 0.13) total *= 1.5 + Math.random() * 1.5;
      const partial = i === n - 1;
      if (partial) total *= 0.42;
      const sv = 0.09 + 0.16 * (i / n) + Math.random() * 0.04;
      const sc = 0.24 + Math.random() * 0.06;
      const vault = total * sv, clob = total * sc, lfj = total - vault - clob;
      const sw = Math.round(total * (95 + Math.random() * 45));
      swaps += sw;
      this.days.push({
        utcDay: dt.toISOString().slice(0, 10),
        lfj: lfj * 1e6, cloberVenue: (clob + vault) * 1e6, cloberVault: vault * 1e6,
        swaps: sw, partial,
      });
    }
    this.totalSwaps = swaps;
  }
  private bumpVolume(): void {
    const d = this.days[this.days.length - 1];
    if (!d) return;
    const add = (0.004 + Math.random() * 0.02) * 1e6;
    const v = add * (0.14 + Math.random() * 0.12), c = add * (0.24 + Math.random() * 0.06), l = add - v - c;
    d.lfj += l; d.cloberVault += v; d.cloberVenue += c + v; d.swaps += Math.round(1 + Math.random() * 2);
    this.totalSwaps += d.swaps;
  }

  // ── fills (DCLogic.makeFill / seedFills / spawnFill) ────────────────────────
  private initEntities(): void {
    for (const p of ['LFJ', 'Clober', 'Vault']) for (const m of MARKETS) this.pools[p + m] = txS();
    this.addrs = Array.from({ length: 14 }, () => txS());
  }

  private makeFill(ageSec: number, big: boolean): SimFill {
    const market = MARKETS[Math.floor(Math.random() * MARKETS.length)];
    const side: Side = Math.random() < 0.5 ? 'buy' : 'sell';
    const proto = wpick<'LFJ' | 'Clober' | 'Vault'>(['LFJ', 'Clober', 'Vault'], [0.5, 0.32, 0.18]);
    let cat: FillCategory = 'DIRECT';
    const cr = Math.random();
    if (proto === 'Vault') cat = cr < 0.45 ? 'CEX/DEX' : 'DIRECT';
    else cat = cr < 0.16 ? 'ROUTER' : cr < 0.24 ? 'AGG' : 'DIRECT';
    const usd = big ? 60000 + Math.random() * 640000 : (Math.random() < 0.72 ? 50 + Math.random() * 9000 : 9000 + Math.random() * 90000);
    const execPx = this.mon * (1 + rnd() * 0.0009);
    const e0 = (proto === 'Vault' ? 0.9 : proto === 'LFJ' ? 0.1 : -0.5) + rnd() * 1.6;
    const ss = side === 'buy' ? 1 : -1;
    let d = 0;
    const mk: number[] = [e0];
    for (const h of [5, 10, 30, 60]) { d += rnd() * Math.sqrt(h) * 1.05; mk.push(e0 + ss * d); }

    const protocol: Protocol = proto === 'LFJ' ? 'LFJ' : 'Clober';
    const scope: Scope = proto === 'Vault' ? 'vault' : 'venue';
    const source: Fill['source'] = proto === 'LFJ' ? 'lfj-swap' : (cat === 'ROUTER' || cat === 'AGG') ? 'clober-router' : 'clober-take';
    const pool = this.pools[proto + market] ?? txS();
    const to = (cat === 'ROUTER' || cat === 'AGG')
      ? this.routers[Math.floor(Math.random() * this.routers.length)]
      : (Math.random() < 0.85 ? this.addrs[Math.floor(Math.random() * this.addrs.length)] : txS());
    const bornMs = Date.now() - ageSec * 1000;

    return {
      id: nextId('sim'), _proto: proto, bornMs,
      protocol, source, scope, market, side, category: cat,
      usd, baseAmount: usd / execPx, execPx,
      txHash: txS(), to, pool,
      blockNumber: Math.max(1, this.block - Math.round(ageSec / 0.4)),
      ts: bornMs, markoutsBps: mk,
    };
  }

  private seedFills(): void {
    for (let i = 0; i < 260; i++) this.fills.push(this.makeFill(Math.random() * 86400, Math.random() < 0.18));
    const recent: SimFill[] = [];
    for (let i = 0; i < 48; i++) recent.push(this.makeFill(Math.random() * 85, Math.random() < 0.12));
    recent.sort((a, b) => a.bornMs - b.bornMs);
    this.fills.push(...recent);
    this.fills.sort((a, b) => a.bornMs - b.bornMs);
    if (this.fills.length > 360) this.fills = this.fills.slice(-360);
  }

  private spawnFill(): void {
    if (Math.random() < 0.55) {
      const f = this.makeFill(0, Math.random() < 0.14);
      this.fills.push(f);
      if (this.fills.length > 360) this.fills.shift();
      this.emitMsg({ ch: 'fill', data: stripFill(f) });
    }
  }

  private tick(): void {
    this.mutate();
    this.block += 2;
    this.bumpVolume();
    this.spawnFill();
    this.emitMsg({ ch: 'state', data: this.getState() });
    this.emitMsg({ ch: 'quotes', data: this.getQuotes() });
    this.emitMsg({ ch: 'volume', data: { ...this.days[this.days.length - 1] } });
  }
}

function stripFill(f: SimFill): Fill {
  const { _proto, bornMs, ...rest } = f;
  return rest;
}
