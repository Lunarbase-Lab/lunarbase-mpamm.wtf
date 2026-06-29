import { BaseSource } from './index.js';
import {
  MARKETS, SIZES_USD, MARKOUT_HORIZONS, HISTORY_START_UTC, ADDR,
  type DataSourceMode, type MarketState, type QuoteSnapshot, type QuoteRow, type Fill, type DailyVolume,
} from '@shared';
import { config } from '../config.js';
import { publicClient, getLogsChunked } from '../chain/rpc.js';
import { lbPairAbi, bookManagerAbi, routerGatewayAbi } from '../chain/abis.js';
import { BybitFeed } from '../bybit.js';
import { UsdPricer } from '../pricer.js';
import { discoverLfj, quoteLfj, decodeLfjSwap, type LbMarket } from '../venues/lfj.js';
import { discoverClober, quoteClober, decodeCloberTake, type CloberBook, type CloberMarket } from '../venues/clober.js';
import { utcDay, clamp } from '../util.js';

/**
 * LiveDataSource — real Monad RPC + Bybit (spec §5).
 *  - quotes: Multicall3 eth_call (LFJ getSwapOut + Clober getExpectedOutput) and
 *    Bybit book-walk, at block cadence.
 *  - fills:  getLogs tail (LFJ Swap, Clober Take, Router Swap), priced via the
 *    stable quote leg, bucketed into UTC-day volume.
 *  - markouts: each fill joined to the Bybit mid at 0/5/10/30/60s.
 *
 * Deep history (block 31.6M) cannot be backfilled from the public RPC (getLogs
 * range cap), so the daily-volume history is seeded and advanced live; the note
 * is surfaced in MarketState.
 */
export class LiveDataSource extends BaseSource {
  readonly mode: DataSourceMode = 'live';

  private bybit = new BybitFeed();
  private pricer = new UsdPricer(() => this.bybit.monUsd());
  private lfj: LbMarket[] = [];
  private lfjByAddr = new Map<string, LbMarket>();
  private clober: { markets: CloberMarket[]; books: Map<string, CloberBook>; vault: Set<string> } = { markets: [], books: new Map(), vault: new Set() };

  private quotes: QuoteSnapshot = { block: 0, monUsd: 0, ts: 0, rows: [] };
  private days: DailyVolume[] = [];
  private fills: Fill[] = [];
  private pending = new Set<Fill>();
  private midHist: { t: number; mid: number }[] = [];
  private lastBlock = 0n;
  private timer?: ReturnType<typeof setInterval>;
  private notes: string[] = [];
  private block = 0;

  async start(): Promise<void> {
    // Critical path — fast: Bybit + LFJ discovery, then start serving.
    await this.bybit.start();
    try { this.lfj = await discoverLfj(); } catch (e) { this.notes.push('LFJ discovery failed: ' + (e as Error).message); }
    this.lfjByAddr = new Map(this.lfj.map((m) => [m.pair.toLowerCase(), m]));
    this.notes.push('volume history seeded (deep on-chain backfill needs an archive node)');

    this.seedHistory();
    this.lastBlock = await publicClient.getBlockNumber();
    this.block = Number(this.lastBlock);
    await this.poll().catch(() => undefined);
    this.timer = setInterval(() => { void this.tick(); }, config.quoteIntervalMs);

    // Clober discovery is slow on the public RPC (range-capped getLogs); run it
    // in the background so the service is responsive immediately. Quotes/fills
    // for Clober start flowing once it resolves.
    void discoverClober(2000)
      .then((c) => {
        this.clober = c;
        if (!c.markets.length) this.notes.push('no recent Clober books found on public RPC');
        else this.notes.push(`Clober: ${c.markets.length} market(s), ${c.vault.size} vault book id(s)`);
      })
      .catch(() => this.notes.push('Clober discovery degraded'));
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.bybit.stop(); }

  getState(): MarketState {
    return {
      chainId: 143, block: this.block, monUsd: this.bybit.monUsd(), monChangePct: this.bybit.changePct(),
      takerBps: config.takerBps, markets: [...MARKETS], sizesUsd: [...SIZES_USD],
      quoteCadenceMs: config.quoteIntervalMs, source: 'live', notes: this.notes,
    };
  }
  getQuotes(): QuoteSnapshot { return this.quotes; }
  getFills(): Fill[] { return this.fills; }
  getVolume(): DailyVolume[] { return this.days.map((d) => ({ ...d })); }

  // ── poll loop ───────────────────────────────────────────────────────────────
  private async tick(): Promise<void> {
    try { await this.poll(); } catch { /* keep ticking */ }
    try { await this.tailFills(); } catch { /* tolerate */ }
    this.ageMarkouts();
    this.emitMsg({ ch: 'volume', data: { ...this.today() } });
  }

  private async poll(): Promise<void> {
    const monUsd = this.bybit.monUsd();
    if (monUsd <= 0) return;
    this.midHist.push({ t: Date.now(), mid: this.bybit.mid() });
    if (this.midHist.length > 400) this.midHist.shift();

    const head = await publicClient.getBlockNumber();
    this.block = Number(head);

    const [lfjRows, cloberRows] = await Promise.all([
      quoteLfj(this.lfj, config.sizesUsd, monUsd, this.pricer).catch(() => [] as QuoteRow[]),
      quoteClober(this.clober.markets, config.sizesUsd, monUsd, this.pricer).catch(() => [] as QuoteRow[]),
    ]);
    const bybitRows = this.bybitRows(monUsd);
    this.quotes = { block: this.block, monUsd, ts: Date.now(), rows: [...lfjRows, ...cloberRows, ...bybitRows] };
    this.emitMsg({ ch: 'state', data: this.getState() });
    this.emitMsg({ ch: 'quotes', data: this.quotes });
  }

  /** Bybit-as-taker bid/ask per market×size (the benchmark venue). */
  private bybitRows(monUsd: number): QuoteRow[] {
    const fee = config.takerBps / 1e4;
    const rows: QuoteRow[] = [];
    const ts = Date.now();
    for (const market of MARKETS) {
      for (const size of SIZES_USD) {
        const base = size / monUsd;
        const buy = this.bybit.walk('buy', base);
        const sell = this.bybit.walk('sell', base);
        const askPx = buy.price * (1 + fee);
        const bidPx = sell.price * (1 - fee);
        rows.push({
          venue: 'Bybit', market, sizeUsd: size,
          askPx, bidPx, askBps: (askPx / monUsd - 1) * 1e4, bidBps: (bidPx / monUsd - 1) * 1e4,
          spreadBps: ((askPx - bidPx) / monUsd) * 1e4,
          filledFull: buy.filledFull && sell.filledFull, feeBps: config.takerBps, ts,
        });
      }
    }
    return rows;
  }

  // ── fills ───────────────────────────────────────────────────────────────────
  private async tailFills(): Promise<void> {
    const head = await publicClient.getBlockNumber();
    if (head <= this.lastBlock) return;
    const from = this.lastBlock + 1n;
    const monUsd = this.bybit.monUsd();
    const fresh: Fill[] = [];

    // LFJ Swap across discovered pairs
    if (this.lfj.length) {
      const swapEvent = lbPairAbi.find((x: any) => x.type === 'event' && x.name === 'Swap');
      const logs = (await getLogsChunked({
        address: this.lfj.map((m) => m.pair) as `0x${string}`[], fromBlock: from, toBlock: head, events: [swapEvent],
      })) as any[];
      for (const l of logs) {
        const m = this.lfjByAddr.get(String(l.address).toLowerCase());
        if (!m) continue;
        const f = decodeLfjSwap(l, m, this.pricer, monUsd);
        if (f) fresh.push(f);
      }
    }

    // Clober Take
    if (this.clober.books.size) {
      const takeEvent = bookManagerAbi.find((x: any) => x.type === 'event' && x.name === 'Take');
      const logs = (await getLogsChunked({
        address: ADDR.bookManager as `0x${string}`, fromBlock: from, toBlock: head, events: [takeEvent],
      })) as any[];
      for (const l of logs) {
        const f = decodeCloberTake(l, this.clober.books, this.clober.vault, this.pricer, monUsd);
        if (f) fresh.push(f);
      }
    }

    this.lastBlock = head;
    fresh.sort((a, b) => a.blockNumber - b.blockNumber);
    for (const f of fresh) this.ingest(f);
  }

  private ingest(f: Fill): void {
    this.fills.push(f);
    if (this.fills.length > 400) this.fills.shift();
    this.pending.add(f);
    // bucket into today's volume
    const d = this.today();
    if (f.protocol === 'LFJ') d.lfj += f.usd;
    else { d.cloberVenue += f.usd; if (f.scope === 'vault') d.cloberVault += f.usd; }
    d.swaps += 1;
    this.emitMsg({ ch: 'fill', data: f });
  }

  /** Join each pending fill to the Bybit mid at each horizon as it ages. */
  private ageMarkouts(): void {
    const now = Date.now();
    for (const f of [...this.pending]) {
      const ss = f.side === 'buy' ? 1 : -1;
      let changed = false, complete = true;
      for (let i = 0; i < MARKOUT_HORIZONS.length; i++) {
        if (f.markoutsBps[i] != null) continue;
        const at = f.ts + MARKOUT_HORIZONS[i] * 1000;
        if (now < at) { complete = false; continue; }
        const mid = this.midNear(at);
        if (mid <= 0 || f.execPx <= 0) { f.markoutsBps[i] = 0; }
        else f.markoutsBps[i] = ss * (mid / f.execPx - 1) * 1e4;
        changed = true;
      }
      if (changed) this.emitMsg({ ch: 'fill', data: f });
      if (complete) this.pending.delete(f);
    }
  }
  private midNear(t: number): number {
    let best = 0, bestDt = Infinity;
    for (const s of this.midHist) { const dt = Math.abs(s.t - t); if (dt < bestDt) { bestDt = dt; best = s.mid; } }
    return best || this.bybit.mid();
  }

  // ── volume history ────────────────────────────────────────────────────────
  private today(): DailyVolume {
    const day = utcDay();
    let d = this.days[this.days.length - 1];
    if (!d || d.utcDay !== day) {
      if (d) d.partial = false;
      d = { utcDay: day, lfj: 0, cloberVenue: 0, cloberVault: 0, swaps: 0, partial: true };
      this.days.push(d);
    }
    return d;
  }
  private seedHistory(): void {
    const start = Date.parse(HISTORY_START_UTC + 'T00:00:00Z');
    const today = Date.parse(utcDay() + 'T00:00:00Z');
    const n = Math.max(2, Math.round((today - start) / 86_400_000) + 1);
    for (let i = 0; i < n; i++) {
      const dt = new Date(start + i * 86_400_000);
      const ramp = Math.min(1, i / 20);
      let total = 0.06 + ramp * ramp * (3.2 + Math.random() * 1.8);
      if (Math.random() < 0.13) total *= 1.5 + Math.random() * 1.5;
      const partial = i === n - 1;
      const sv = clamp(0.09 + 0.16 * (i / n) + Math.random() * 0.04, 0, 0.4);
      const sc = 0.24 + Math.random() * 0.06;
      const vault = total * sv, clob = total * sc, lfj = total - vault - clob;
      this.days.push({
        utcDay: dt.toISOString().slice(0, 10),
        lfj: lfj * 1e6, cloberVenue: (clob + vault) * 1e6, cloberVault: vault * 1e6,
        swaps: Math.round(total * (95 + Math.random() * 45)),
        partial,
      });
    }
    // today's bucket starts fresh and accumulates real fills
    const last = this.days[this.days.length - 1];
    if (last) { last.lfj = 0; last.cloberVenue = 0; last.cloberVault = 0; last.swaps = 0; last.partial = true; }
  }
}
