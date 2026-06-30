import { useMemo } from 'react';
import { SIZES_USD, VENUE_COLOR, type Venue, type QuoteRow } from '@shared';
import { useDashboard, VENUES } from '../store';
import { C, hexA, pill } from '../theme';
import { Panel, PanelHead, Field } from '../components/ui';
import { QuoteCanvas } from '../components/QuoteCanvas';
import { sgn, sizeLabel, percentile, stdev } from '../lib/format';

const AX = 22; // bps axis half-range for the depth ladder

export function ExecutionTab() {
  const d = useDashboard();
  const pair = d.pair, size = d.size;
  const markets = d.state?.markets ?? ['MON/USDC', 'MON/USDT0', 'MON/AUSD', 'MON/USD1'];
  const active = VENUES.filter((v) => d.venues[v]);
  const taker = (d.state?.takerBps ?? 10).toFixed(1);

  const row = (v: Venue, s: number): QuoteRow | undefined =>
    d.quotes?.rows.find((r) => r.venue === v && r.market === pair && r.sizeUsd === s);

  // legend — active venues at selected pair/size, sorted by spread
  const legend = useMemo(() => {
    const leg = active.map((v) => {
      const r = row(v, size);
      return { name: v, color: VENUE_COLOR[v], spread: r?.spreadBps ?? 0, bid: r?.bidBps ?? 0, ask: r?.askBps ?? 0, has: !!r };
    }).filter((x) => x.has);
    leg.sort((a, b) => a.spread - b.spread);
    return leg;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.quotes, d.venues, pair, size, d.frame]);
  const tight = legend[0]?.name;

  // depth ladder — per size, per venue bar widths
  const depth = useMemo(() => SIZES_USD.map((sz) => {
    const segsBid: { w: number; color: string }[] = [];
    const segsAsk: { w: number; color: string }[] = [];
    for (const v of active) {
      const r = row(v, sz);
      if (!r) continue;
      const wb = Math.min(50, Math.abs(Math.min(0, r.bidBps)) / AX * 50);
      const wa = Math.min(50, Math.max(0, r.askBps) / AX * 50);
      segsBid.push({ w: wb, color: VENUE_COLOR[v] });
      segsAsk.push({ w: wa, color: VENUE_COLOR[v] });
    }
    segsBid.sort((a, b) => b.w - a.w); segsAsk.sort((a, b) => b.w - a.w);
    return { label: sizeLabel(sz), highlight: sz === size, segsBid, segsAsk };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [d.quotes, d.venues, pair, size, d.frame]);

  // rolling stats — percentiles of the spread sample buffer per venue
  const stats = useMemo(() => {
    const rows = active.map((v) => {
      const a = d.samples[v] ?? [];
      return {
        name: v, color: VENUE_COLOR[v],
        p5: percentile(a, .05), p25: percentile(a, .25), p50: percentile(a, .5),
        p75: percentile(a, .75), p95: percentile(a, .95),
        avg: a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, sd: stdev(a), n: a.length,
      };
    });
    const tightest = rows.length ? rows.reduce((m, r) => (r.p50 < m.p50 ? r : m), rows[0]).name : null;
    return { rows, tightest };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.frame, d.venues]);

  return (
    <div>
      <div style={{ padding: '18px 18px 10px' }}>
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.06em' }}>REALTIME EXECUTION COMPARISON</div>
        <div style={{ fontSize: 11, color: C.dim3, marginTop: 6, lineHeight: 1.55, maxWidth: 880 }}>
          Last 60s of quotes for the selected pair at the chosen notional. Spreads are quoted vs the Bybit <span style={{ color: C.text3 }}>MONUSDT</span> BBO mid.{' '}
          <span style={{ color: C.text3 }}>Bybit (taker)</span> walks the live book for the requested size and overlays the configured taker fee ({taker} bps each side) — realized-vs-realized, the only honest comparison for size-sensitive flow.
        </div>
      </div>

      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap', padding: '6px 18px 16px' }}>
        <Field label="ASSET">
          <div style={{ display: 'flex', gap: 4 }}>
            {markets.map((p) => <div key={p} onClick={() => d.set('pair', p)} style={pill(pair === p)}>{p}</div>)}
          </div>
        </Field>
        <Field label="SIZE">
          <div style={{ display: 'flex', gap: 4 }}>
            {SIZES_USD.map((s) => <div key={s} onClick={() => d.set('size', s)} style={pill(size === s)}>{sizeLabel(s)}</div>)}
          </div>
        </Field>
        <div style={{ marginLeft: 'auto' }}>
          <Field label="VENUES">
            <div style={{ display: 'flex', gap: 4 }}>
              {VENUES.map((v) => {
                const on = d.venues[v];
                return (
                  <div key={v} onClick={() => d.toggleVenue(v)} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 4, cursor: 'pointer',
                    fontSize: 11, whiteSpace: 'nowrap',
                    border: `1px solid ${on ? hexA(VENUE_COLOR[v], 0.5) : 'rgba(255,255,255,.1)'}`,
                    color: on ? C.text : C.faint2, background: on ? hexA(VENUE_COLOR[v], 0.12) : 'transparent',
                  }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: on ? VENUE_COLOR[v] : C.ghost }} />
                    {v === 'Bybit' ? 'BYBIT (taker)' : v.toUpperCase()}
                  </div>
                );
              })}
            </div>
          </Field>
        </div>
      </div>

      {/* QUOTE */}
      <Panel style={{ margin: '0 18px 14px' }}>
        <PanelHead icon="~" title="QUOTE" sub={`${pair} · ${sizeLabel(size)} · last 60s`}
          right={<div style={{ fontSize: 9, color: C.faint2 }}>solid = ask · dashed = bid · ★ = tightest spread</div>} />
        <div style={{ position: 'relative', padding: '8px 8px 4px' }}>
          <QuoteCanvas />
          <div style={{ position: 'absolute', top: 14, right: 16, background: 'rgba(10,12,16,.82)', border: '1px solid rgba(255,255,255,.1)', padding: '8px 10px', minWidth: 248, backdropFilter: 'blur(3px)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 54px 50px 50px', gap: '2px 8px', fontSize: 8.5, color: C.faint2, letterSpacing: '.05em', paddingBottom: 5, borderBottom: `1px solid ${C.line}` }}>
              <div>VENUE</div><div style={{ textAlign: 'right' }}>SPREAD</div><div style={{ textAlign: 'right' }}>BID</div><div style={{ textAlign: 'right' }}>ASK</div>
            </div>
            {legend.map((r) => (
              <div key={r.name} style={{ display: 'grid', gridTemplateColumns: '1fr 54px 50px 50px', gap: '2px 8px', fontSize: 11, padding: '4px 0', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color }} />
                  <span style={{ color: C.text2 }}>{r.name}</span>
                  <span style={{ fontSize: 9, color: r.name === tight ? C.green : 'transparent' }}>★</span>
                </div>
                <div style={{ textAlign: 'right', color: r.name === tight ? C.green : C.text, fontWeight: 600 }}>{r.spread.toFixed(2)}</div>
                <div style={{ textAlign: 'right', color: C.red }}>{sgn(r.bid)}</div>
                <div style={{ textAlign: 'right', color: C.green }}>{sgn(r.ask)}</div>
              </div>
            ))}
          </div>
        </div>
      </Panel>

      {/* BID_ASK_DEPTH */}
      <Panel style={{ margin: '0 18px 14px' }}>
        <PanelHead icon="≡" title="BID_ASK_DEPTH" sub={`${pair} · spread vs Bybit mid (bps) by trade size`} />
        <div style={{ padding: '16px 18px 8px' }}>
          <div style={{ display: 'flex', paddingLeft: 64, marginBottom: 10 }}>
            <div style={{ flex: 1, textAlign: 'center', fontSize: 9, color: C.faint2, letterSpacing: '.1em' }}>BIDS — below mid</div>
            <div style={{ flex: 1, textAlign: 'center', fontSize: 9, color: C.faint2, letterSpacing: '.1em' }}>ASKS — above mid</div>
          </div>
          {depth.map((rowd) => (
            <div key={rowd.label} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34, background: rowd.highlight ? 'rgba(131,110,249,.06)' : undefined }}>
              <div style={{ width: 54, textAlign: 'right', fontSize: 11, color: C.dim }}>{rowd.label}</div>
              <div style={{ position: 'relative', flex: 1, height: 20 }}>
                <div style={{ position: 'absolute', left: '50%', top: -3, bottom: -3, width: 1, background: 'rgba(53,208,160,.55)', zIndex: 5 }} />
                {rowd.segsBid.map((s, i) => <div key={'b' + i} style={{ position: 'absolute', top: 2, height: 16, right: '50%', width: `${s.w.toFixed(2)}%`, background: hexA(s.color, 0.9), borderRadius: '2px 0 0 2px' }} />)}
                {rowd.segsAsk.map((s, i) => <div key={'a' + i} style={{ position: 'absolute', top: 2, height: 16, left: '50%', width: `${s.w.toFixed(2)}%`, background: hexA(s.color, 0.9), borderRadius: '0 2px 2px 0' }} />)}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <div style={{ width: 54 }} />
            <div style={{ position: 'relative', flex: 1, height: 16 }}>
              {[-20, -15, -10, -5, 0, 5, 10, 15, 20].map((t) => (
                <div key={t} style={{ position: 'absolute', top: 0, left: `${50 + t / AX * 50}%`, transform: 'translateX(-50%)', fontSize: 8.5, color: t === 0 ? C.green : C.faint2 }}>{(t > 0 ? '+' : '') + t}</div>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      {/* ROLLING_STATS */}
      <Panel style={{ margin: '0 18px 14px' }}>
        <PanelHead icon="#" title="ROLLING_STATS" sub={`last 5m · spread distribution by venue · ${sizeLabel(size)} · ${pair}`} />
        <div style={{ padding: '6px 14px 12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr repeat(7, 1fr) 0.8fr', gap: 6, padding: '9px 6px', fontSize: 9, color: C.faint2, letterSpacing: '.05em', borderBottom: `1px solid ${C.line}` }}>
            <div>VENUE</div><div style={{ textAlign: 'right' }}>P5</div><div style={{ textAlign: 'right' }}>P25</div><div style={{ textAlign: 'right' }}>P50</div><div style={{ textAlign: 'right' }}>P75</div><div style={{ textAlign: 'right' }}>P95</div><div style={{ textAlign: 'right' }}>AVG</div><div style={{ textAlign: 'right' }}>σ</div><div style={{ textAlign: 'right' }}>N</div>
          </div>
          {stats.rows.map((r) => (
            <div key={r.name} style={{ display: 'grid', gridTemplateColumns: '1.4fr repeat(7, 1fr) 0.8fr', gap: 6, padding: '8px 6px', fontSize: 11.5, borderBottom: `1px solid ${C.line3}`, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color }} />
                <span style={{ color: C.text2 }}>{r.name}</span>
                <span style={{ fontSize: 9, color: r.name === stats.tightest ? C.green : 'transparent' }}>★</span>
              </div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p5.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p25.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: r.name === stats.tightest ? C.green : C.text, fontWeight: 600 }}>{r.p50.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p75.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p95.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim3 }}>{r.avg.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim3 }}>{r.sd.toFixed(4)}</div>
              <div style={{ textAlign: 'right', color: C.faint2 }}>{r.n}</div>
            </div>
          ))}
          <div style={{ fontSize: 9, color: C.faint3, marginTop: 9 }}>p50 = median round-trip spread (bps, bid/ask vs the Bybit MONUSDT mid) · σ = spread stdev · ★ = tightest p50 in window</div>
        </div>
      </Panel>
    </div>
  );
}
