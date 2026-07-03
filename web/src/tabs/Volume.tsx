import { useMemo } from 'react';
import type { DailyVolume } from '@shared';
import { useDashboard } from '../store';
import { C, venueColor } from '../theme';
import { fMillions } from '../lib/format';

/** MM-DD from a 'YYYY-MM-DD' UTC day. */
const mmdd = (utcDay: string): string => utcDay.slice(5);

interface SeriesDef {
  id: string;
  name: string;
  color: string;
  val: (d: DailyVolume) => number;
  /** real per-source swap count for this series (no USD proration). */
  swaps: (d: DailyVolume) => number;
}

export function VolumeTab() {
  const d = useDashboard();

  const vm = useMemo(() => {
    const days = d.volume;
    const nd = days.length;
    // market-share in-chart labels: cream over the saturated bands in bright, the band color in dark.
    const msLabelColor = (bandColor: string) => (d.theme === 'light' ? 'rgb(252,251,248)' : bandColor);

    // propAMM venues from the registry — one series per role==='venue' venue.
    // Colors, names and ids all come from state.venues (nothing hardcoded).
    const series: SeriesDef[] = d.displayVenues.map((v) => ({
      id: v.id,
      name: v.name,
      color: venueColor(v, d.theme),
      val: (x) => x.byVenue[v.id]?.usd ?? 0,
      swaps: (x) => x.byVenue[v.id]?.swaps ?? 0,
    }));

    const f = (m: number) => fMillions(m);

    // first UTC day this venue recorded any notional (venue-agnostic; '—' if none).
    const firstActive = (s: SeriesDef): string => {
      for (const x of days) if (s.val(x) > 0) return x.utcDay;
      return '—';
    };
    // earliest first-active across shown venues — the "since" / total-row anchor.
    const earliestActive = (): string => {
      const fs = series.map(firstActive).filter((x) => x !== '—').sort();
      return fs[0] ?? '—';
    };

    const scopeNote = "USD-stable quote leg of each landed swap · today's bucket is partial";

    // empty-state: render placeholder zeros, no crash (also the pre-registry case
    // where displayVenues is still []).
    if (nd === 0 || series.length === 0) {
      return {
        volBars: [] as { op: number; segs: { h: string; color: string }[] }[],
        volMaxLabel: f(0), volMidLabel: f(0),
        volAxis: [] as { label: string; left: string }[],
        kAll: f(0), k7: f(0), k7chg: '▲ 0%', k7css: C.green,
        kSwaps: '0', kPeak: f(0), kPeakDay: '—',
        kToday: f(0), kTodayChg: '▲ 0%', kTodaycss: C.green,
        since: '—',
        legRows: series.map((s) => ({ name: s.name, color: s.color, vol: f(0), share: '0.0%' })),
        legTotal: f(0), cumLine: '', cumArea: '', cumSigma: f(0),
        msBands: [] as { path: string; color: string }[],
        msTopName: series.length ? series[series.length - 1].name : '—', msTopPct: '0.0%',
        msTopColor: msLabelColor(series.length ? series[series.length - 1].color : C.faint2),
        msBotName: series.length ? series[0].name : '—', msBotPct: '0.0%',
        msBotColor: msLabelColor(series.length ? series[0].color : C.faint2),
        brk: series.map((s) => ({
          name: s.name, color: s.color, vol: f(0), share: '0.0%', shareW: '0.0',
          swaps: '0', peakV: f(0), peakDay: '—', first: '—',
        })),
        brkTotalVol: f(0), brkTotalSwaps: '0', brkTotalFirst: '—',
        volScopeNote: scopeNote,
      };
    }

    const dayTotal = (x: DailyVolume) => series.reduce((a, s) => a + s.val(x), 0);
    const maxT = Math.max(...days.map(dayTotal)) || 1;
    const H = 150;
    const volBars = days.map((x) => ({
      op: x.partial ? 0.5 : 1,
      segs: series.map((s) => ({ h: (s.val(x) / maxT * H).toFixed(1), color: s.color })),
    }));

    const totals = series.map((s) => ({ name: s.name, color: s.color, tot: days.reduce((a, x) => a + s.val(x), 0) }));
    const allTot = totals.reduce((a, t) => a + t.tot, 0);
    const share = (x: number) => (allTot ? (x / allTot * 100) : 0).toFixed(1) + '%';

    const dTot = days.map(dayTotal);
    // real trailing 7-calendar-day windows anchored on the latest day present —
    // NOT the last 7 *recorded* rows, which skip dormant (zero-volume) days and
    // so silently stretch each "week" across a longer span.
    const anchor = days[nd - 1].utcDay;
    const dayAgo = (n: number) =>
      new Date(new Date(anchor + 'T00:00:00Z').getTime() - n * 86_400_000).toISOString().slice(0, 10);
    const c7 = dayAgo(7), c14 = dayAgo(14);
    const last7 = days.filter((x) => x.utcDay > c7 && x.utcDay <= anchor).reduce((a, x) => a + dayTotal(x), 0);
    const prev7 = days.filter((x) => x.utcDay > c14 && x.utcDay <= c7).reduce((a, x) => a + dayTotal(x), 0);
    // % vs the prior week; null when the prior week had no volume (base 0 → % undefined)
    const chg7 = prev7 > 0 ? (last7 - prev7) / prev7 * 100 : null;

    let peakV = -1, peakDay = '';
    days.forEach((x, i) => { if (dTot[i] > peakV) { peakV = dTot[i]; peakDay = mmdd(x.utcDay); } });

    const todayT = dTot[nd - 1], prevT = dTot[nd - 2];
    const todayChg = prevT ? (todayT - prevT) / prevT * 100 : 0;

    // KPI "total swaps" sums the real per-venue swap counts across shown venues
    // (no USD proration); seeded days that carry usd but swaps:0 add nothing here.
    const swaps = days.reduce((a, x) => a + series.reduce((b, s) => b + s.swaps(x), 0), 0);
    const since = earliestActive();

    const W = 1000, HC = 260;
    let cum = 0;
    const pts = days.map((x, i) => { cum += dTot[i]; return [nd > 1 ? i / (nd - 1) * W : 0, cum] as [number, number]; });
    const cy = (y: number) => HC - (cum ? y / cum * HC : HC);
    const cumLine = 'M' + pts.map((p) => p[0].toFixed(1) + ',' + cy(p[1]).toFixed(1)).join(' L');
    const cumArea = cumLine + ' L' + W + ',' + HC + ' L0,' + HC + ' Z';

    const xs = (i: number) => (nd > 1 ? i / (nd - 1) * W : 0);
    const bands = series.map(() => ({ top: [] as [number, number][], bot: [] as [number, number][] }));
    days.forEach((x, i) => {
      const t = dTot[i] || 1;
      let below = 0;
      for (let k = 0; k < series.length; k++) {
        const fr = series[k].val(x) / t;
        bands[k].bot.push([xs(i), HC * (1 - below)]);
        bands[k].top.push([xs(i), HC * (1 - below - fr)]);
        below += fr;
      }
    });
    const band = (top: [number, number][], bot: [number, number][]) =>
      'M' + top.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L')
      + ' L' + bot.slice().reverse().map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L') + ' Z';
    const msBands = series.map((s, k) => ({ path: band(bands[k].top, bands[k].bot), color: s.color }));

    const lt = dTot[nd - 1] || 1;
    const pPeak = (s: SeriesDef) => {
      let pv = -1, pd = '';
      days.forEach((x) => { const v = s.val(x); if (v > pv) { pv = v; pd = mmdd(x.utcDay); } });
      return { v: f(pv), day: pd };
    };
    // real per-source swap counts (no USD proration): each venue counts its own takes.
    const brkSwaps = series.map((s) => days.reduce((a, x) => a + s.swaps(x), 0));
    const brkSwapTotal = brkSwaps.reduce((a, b) => a + b, 0);
    const brk = series.map((s, k) => {
      const tot = days.reduce((a, x) => a + s.val(x), 0);
      const pk = pPeak(s);
      return {
        name: s.name, color: s.color, vol: f(tot), share: share(tot),
        shareW: (allTot ? tot / allTot * 100 : 0).toFixed(1),
        swaps: brkSwaps[k].toLocaleString(),
        peakV: pk.v, peakDay: pk.day,
        first: firstActive(s),
      };
    });

    const axis = [0, Math.floor(nd * 0.25), Math.floor(nd * 0.5), Math.floor(nd * 0.75), nd - 1]
      .map((i) => ({ label: mmdd(days[i].utcDay), left: (nd > 1 ? i / (nd - 1) * 100 : 0).toFixed(1) + '%' }));

    return {
      volBars, volMaxLabel: f(maxT), volMidLabel: f(maxT / 2), volAxis: axis,
      kAll: f(allTot), k7: f(last7),
      k7chg: chg7 == null ? (last7 > 0 ? '▲ ∞%' : '▲ 0%') : (chg7 >= 0 ? '▲ ' : '▼ ') + Math.abs(chg7).toFixed(0) + '%',
      k7css: chg7 == null ? (last7 > 0 ? C.green : C.faint2) : (chg7 >= 0 ? C.green : C.red),
      kSwaps: swaps.toLocaleString(), kPeak: f(peakV), kPeakDay: peakDay,
      kToday: f(todayT),
      kTodayChg: (todayChg >= 0 ? '▲ ' : '▼ ') + Math.abs(todayChg).toFixed(0) + '%',
      kTodaycss: todayChg >= 0 ? C.green : C.red,
      since,
      legRows: totals.map((t) => ({ name: t.name, color: t.color, vol: f(t.tot), share: share(t.tot) })),
      legTotal: f(allTot), cumLine, cumArea, cumSigma: f(allTot),
      msBands,
      msTopName: series[series.length - 1].name,
      msTopPct: (series[series.length - 1].val(days[nd - 1]) / lt * 100).toFixed(1) + '%',
      msTopColor: msLabelColor(series[series.length - 1].color),
      msBotName: series[0].name,
      msBotPct: (series[0].val(days[nd - 1]) / lt * 100).toFixed(1) + '%',
      msBotColor: msLabelColor(series[0].color),
      brk, brkTotalVol: f(allTot), brkTotalSwaps: brkSwapTotal.toLocaleString(), brkTotalFirst: since,
      volScopeNote: scopeNote,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.volume, d.theme, d.displayVenues]);

  return (
    <div>
      <div style={{ padding: '18px 18px 14px' }}>
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.06em', color: C.text }}>PROPAMM VOLUME</div>
        <div style={{ fontSize: 11, color: C.dim3, marginTop: 6, lineHeight: 1.55, maxWidth: 760 }}>
          All-time daily notional traded on tracked propAMM venues, split by venue. Volume is the USD-stable quote leg of each landed swap; buckets are UTC days and today's bucket is partial.
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 0, border: `1px solid ${C.line}`, margin: '0 18px 14px' }}>
        <div style={{ padding: '14px 16px', borderRight: `1px solid ${C.line2}` }}>
          <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.06em' }}>ALL-TIME VOLUME</div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 8, color: C.text }}>{vm.kAll}</div>
          <div style={{ fontSize: 10, color: C.faint2, marginTop: 6 }}>since {vm.since}</div>
        </div>
        <div style={{ padding: '14px 16px', borderRight: `1px solid ${C.line2}` }}>
          <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.06em' }}>7D VOLUME</div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 8, color: C.text }}>{vm.k7}</div>
          <div style={{ fontSize: 10, marginTop: 6, color: vm.k7css }}>{vm.k7chg} <span style={{ color: C.faint2 }}>vs prior 7d</span></div>
        </div>
        <div style={{ padding: '14px 16px', borderRight: `1px solid ${C.line2}` }}>
          <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.06em' }}>INDEXED SWAPS</div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 8, color: C.text }}>{vm.kSwaps}</div>
          <div style={{ fontSize: 10, color: C.faint2, marginTop: 6 }} title="On-chain swaps decoded forward + reconciled from retained fills, across tracked venues. Seeded history may carry volume but no per-swap count, so it isn't included here.">tracked venues · indexed</div>
        </div>
        <div style={{ padding: '14px 16px', borderRight: `1px solid ${C.line2}` }}>
          <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.06em' }}>PEAK DAY</div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 8, color: C.text }}>{vm.kPeak}</div>
          <div style={{ fontSize: 10, color: C.faint2, marginTop: 6 }}>{vm.kPeakDay}</div>
        </div>
        <div style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 9, color: C.faint2, letterSpacing: '.06em' }}>TODAY (PARTIAL)</div>
          <div style={{ fontSize: 22, fontWeight: 600, marginTop: 8, color: C.text }}>{vm.kToday}</div>
          <div style={{ fontSize: 10, marginTop: 6, color: vm.kTodaycss }}>{vm.kTodayChg} <span style={{ color: C.faint2 }}>vs prev day</span></div>
        </div>
      </div>

      {/* DAILY_VOLUME */}
      <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
        <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
        <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />
        <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
          <span style={{ color: C.purple }}>~</span> <span style={{ color: C.text, fontWeight: 600 }}>DAILY_VOLUME</span> <span style={{ color: C.faint }}>USD notional by venue · UTC days · {vm.volScopeNote}</span>
        </div>
        {/* flex row: the bars end where the summary column begins, so the newest
            (right-most) bars never render underneath it — no absolute overlay. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '16px 18px 8px' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <div style={{ position: 'absolute', top: -2, left: 0, fontSize: 8.5, color: C.faint2 }}>{vm.volMaxLabel}</div>
            <div style={{ position: 'absolute', top: 72, left: 0, fontSize: 8.5, color: C.faint2 }}>{vm.volMidLabel}</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 150, paddingLeft: 42, borderBottom: `1px solid ${C.line}` }}>
              {vm.volBars.map((b, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column-reverse', flex: 1, gap: 1, opacity: b.op }}>
                  {b.segs.map((s, j) => <div key={j} style={{ height: `${s.h}px`, background: s.color }} />)}
                </div>
              ))}
            </div>
            <div style={{ position: 'relative', height: 14, marginTop: 4, marginLeft: 42 }}>
              {vm.volAxis.map((a, i) => (
                <div key={i} style={{ position: 'absolute', left: a.left, transform: 'translateX(-50%)', fontSize: 8.5, color: C.faint2 }}>{a.label}</div>
              ))}
            </div>
          </div>
          {/* summary table — a real column now (was an absolute overlay hiding the newest bars) */}
          <div style={{ flex: 'none', width: 248, background: C.overlay, border: `1px solid ${C.line}`, padding: '8px 10px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 44px', gap: '3px 8px', fontSize: 8.5, color: C.faint2, letterSpacing: '.05em', paddingBottom: 5, borderBottom: `1px solid ${C.line}` }}>
              <div>VENUE</div><div style={{ textAlign: 'right' }}>ALL-TIME</div><div style={{ textAlign: 'right' }}>SHARE</div>
            </div>
            {vm.legRows.map((r) => (
              <div key={r.name} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 44px', gap: '3px 8px', fontSize: 10.5, padding: '4px 0', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flex: 'none' }} />
                  <span style={{ color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{r.name}</span>
                </div>
                <div style={{ textAlign: 'right', color: C.text }}>{r.vol}</div>
                <div style={{ textAlign: 'right', color: C.dim }}>{r.share}</div>
              </div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 44px', gap: '3px 8px', fontSize: 10.5, paddingTop: 6, marginTop: 3, borderTop: `1px solid ${C.line}` }}>
              <div style={{ color: C.dim3 }}>TOTAL</div>
              <div style={{ textAlign: 'right', color: C.text, fontWeight: 600 }}>{vm.legTotal}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>100%</div>
            </div>
          </div>
        </div>
      </div>

      {/* CUMULATIVE + MARKET SHARE */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, margin: '0 18px 14px' }}>
        <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel }}>
          <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
          <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
            <span style={{ color: C.purple }}>■</span> <span style={{ color: C.text, fontWeight: 600 }}>CUMULATIVE_VOLUME</span>
          </div>
          <div style={{ position: 'relative', padding: '14px 14px 10px' }}>
            <svg viewBox="0 0 1000 260" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 230 }}>
              <defs>
                {/* SVG presentation attrs can't use var() — theme via style instead. */}
                <linearGradient id="cumg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: 'var(--accent)' }} stopOpacity="0.32" />
                  <stop offset="100%" style={{ stopColor: 'var(--accent)' }} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path d={vm.cumArea} fill="url(#cumg)" />
              <path d={vm.cumLine} fill="none" style={{ stroke: 'var(--accent2)', strokeWidth: 2 }} vectorEffect="non-scaling-stroke" />
            </svg>
            <div style={{ position: 'absolute', top: 14, right: 16, fontSize: 11, color: C.purpleL }}>Σ {vm.cumSigma}</div>
          </div>
        </div>
        <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel }}>
          <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
          <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
            <span style={{ color: C.purple }}>◆</span> <span style={{ color: C.text, fontWeight: 600 }}>MARKET_SHARE</span> <span style={{ color: C.faint }}>% of daily volume</span>
          </div>
          <div style={{ position: 'relative', padding: '14px 14px 10px' }}>
            <svg viewBox="0 0 1000 260" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 230 }}>
              {vm.msBands.map((band, i) => <path key={i} d={band.path} fill={band.color} fillOpacity="0.82" />)}
            </svg>
            <div style={{ position: 'absolute', top: 18, right: 16, fontSize: 9, color: vm.msTopColor }}>{vm.msTopName} {vm.msTopPct}</div>
            <div style={{ position: 'absolute', bottom: 34, right: 16, fontSize: 9, color: vm.msBotColor }}>{vm.msBotName} {vm.msBotPct}</div>
          </div>
        </div>
      </div>

      {/* VENUE_BREAKDOWN */}
      <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
        <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
        <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />
        <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
          <span style={{ color: C.purple }}>#</span> <span style={{ color: C.text, fontWeight: 600 }}>VENUE_BREAKDOWN</span>
        </div>
        <div style={{ padding: '6px 14px 12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.4fr 1fr 1.2fr 1fr', gap: 8, padding: '9px 6px', fontSize: 9, color: C.faint2, letterSpacing: '.05em', borderBottom: `1px solid ${C.line}` }}>
            <div>VENUE</div><div style={{ textAlign: 'right' }}>ALL-TIME VOL</div><div>SHARE</div><div style={{ textAlign: 'right' }}>SWAPS</div><div style={{ textAlign: 'right' }}>PEAK DAY</div><div style={{ textAlign: 'right' }}>FIRST ACTIVE</div>
          </div>
          {vm.brk.map((r) => (
            <div key={r.name} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.4fr 1fr 1.2fr 1fr', gap: 8, padding: '10px 6px', fontSize: 11.5, borderBottom: `1px solid ${C.line3}`, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color }} />
                <span style={{ color: C.text2 }}>{r.name}</span>
              </div>
              <div style={{ textAlign: 'right', color: C.text }}>{r.vol}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 5, background: C.line2, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${r.shareW}%`, background: r.color }} />
                </div>
                <span style={{ color: C.dim, width: 40, textAlign: 'right' }}>{r.share}</span>
              </div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.swaps}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.peakV} <span style={{ color: C.faint2 }}>{r.peakDay}</span></div>
              <div style={{ textAlign: 'right', color: C.dim3 }}>{r.first}</div>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.4fr 1fr 1.2fr 1fr', gap: 8, padding: '10px 6px', fontSize: 11.5, alignItems: 'center' }}>
            <div style={{ color: C.dim3 }}>TOTAL</div>
            <div style={{ textAlign: 'right', color: C.text, fontWeight: 600 }}>{vm.brkTotalVol}</div>
            <div style={{ color: C.dim }}>100%</div>
            <div style={{ textAlign: 'right', color: C.dim }}>{vm.brkTotalSwaps}</div>
            <div style={{ textAlign: 'right', color: C.faint2 }}>—</div>
            <div style={{ textAlign: 'right', color: C.dim3 }}>{vm.brkTotalFirst}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
