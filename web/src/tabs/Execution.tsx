import { useEffect, useMemo } from 'react';
import { SIZES_USD, type VenueMeta, type QuoteRow } from '@shared';
import { useDashboard } from '../store';
import { C, hexA, pill, venueColor } from '../theme';
import { Panel, PanelHead, Field } from '../components/ui';
import { QuoteCanvas } from '../components/QuoteCanvas';
import { sgn, sizeLabel, percentile, stdev } from '../lib/format';

const AX = 22; // bps axis half-range for the depth ladder
const DEFAULT_MARKETS = ['MON/USDC', 'MON/USDT0', 'MON/AUSD', 'MON/USD1'];

export function ExecutionTab() {
  const d = useDashboard();
  const pair = d.pair, size = d.size;
  const allMarkets = d.state?.markets ?? DEFAULT_MARKETS;
  const markets = useMemo(() => {
    if (!d.quotes) return allMarkets;
    const venueIds = new Set(d.displayVenues.map((v) => v.id));
    const withVenue = new Set(d.quotes.rows.filter((r) => venueIds.has(r.venueId)).map((r) => r.market));
    return allMarkets.filter((m) => withVenue.has(m));
  }, [allMarkets, d.quotes, d.displayVenues]);
  useEffect(() => {
    if (markets.length && !markets.includes(pair)) d.set('pair', markets[0]);
  }, [markets, pair, d]);
  // toggle chips: every propAMM venue + the CEX reference (if the registry has one).
  const chips: VenueMeta[] = d.reference ? [...d.displayVenues, d.reference] : d.displayVenues;
  // active = chips the user has enabled (all registry venues default on).
  const active = chips.filter((v) => d.venueToggles[v.id]);
  const taker = (d.state?.takerBps ?? 10).toFixed(1);
  // reference (CEX benchmark) name. The prose below explains it's walked as a taker
  // (book + fee), so we don't tag the name itself with a confusing "(taker)" suffix.
  const ref = d.reference;
  const refName = ref?.name ?? 'the CEX reference';
  const refLabel = ref ? ref.name : 'The reference';

  const row = (v: VenueMeta, s: number): QuoteRow | undefined =>
    d.quotes?.rows.find((r) => r.venueId === v.id && r.market === pair && r.sizeUsd === s);

  // legend — active venues at selected pair/size, sorted by spread
  const legend = useMemo(() => {
    const leg = active.map((v) => {
      const r = row(v, size);
      return {
        id: v.id, name: v.name, color: venueColor(v, d.theme),
        spread: r?.spreadBps ?? 0, bid: r?.bidBps ?? 0, ask: r?.askBps ?? 0,
        // realized buy-MON cost vs the reference-as-taker, + = on-chain worse (spec §4.2)
        vsCex: r?.cexAskBps, has: !!r,
        // a one-sided quote has only one executable side (the other is thin/backstop);
        // a partial quote (filledFull=false) exhausts before the full notional.
        oneSided: !!r?.oneSided, hasBid: (r?.bidPx ?? 0) > 0, hasAsk: (r?.askPx ?? 0) > 0,
        full: r?.filledFull ?? true,
      };
    }).filter((x) => x.has);
    // executable full-size two-sided rows first (by spread), then partial, then one-sided
    const rank = (x: { oneSided: boolean; full: boolean }) => (x.oneSided ? 2 : !x.full ? 1 : 0);
    leg.sort((a, b) => rank(a) - rank(b) || a.spread - b.spread);
    return leg;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.quotes, d.venueToggles, d.venues, pair, size, d.frame, d.theme]);
  // tightest = tightest genuinely-executable quote (full-size + two-sided), by id
  const tight = legend.find((x) => !x.oneSided && x.full)?.id;

  // depth ladder — per size, per venue bar widths
  const depth = useMemo(() => SIZES_USD.map((sz) => {
    const segsBid: { w: number; color: string; full: boolean }[] = [];
    const segsAsk: { w: number; color: string; full: boolean }[] = [];
    for (const v of active) {
      const r = row(v, sz);
      if (!r) continue;
      const wb = Math.min(50, Math.abs(Math.min(0, r.bidBps)) / AX * 50);
      const wa = Math.min(50, Math.max(0, r.askBps) / AX * 50);
      const color = venueColor(v, d.theme);
      // dim a venue's bar at a size it can't fill fully (filledFull=false)
      segsBid.push({ w: wb, color, full: r.filledFull });
      segsAsk.push({ w: wa, color, full: r.filledFull });
    }
    segsBid.sort((a, b) => b.w - a.w); segsAsk.sort((a, b) => b.w - a.w);
    return { label: sizeLabel(sz), highlight: sz === size, segsBid, segsAsk };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [d.quotes, d.venueToggles, d.venues, pair, size, d.frame, d.theme]);

  // rolling stats — percentiles of the spread sample buffer per venue
  const stats = useMemo(() => {
    const rows = active.map((v) => {
      const a = d.samples[v.id] ?? [];
      return {
        id: v.id, name: v.name, color: venueColor(v, d.theme),
        p5: percentile(a, .05), p25: percentile(a, .25), p50: percentile(a, .5),
        p75: percentile(a, .75), p95: percentile(a, .95),
        avg: a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, sd: stdev(a), n: a.length,
      };
    });
    const tightest = rows.length ? rows.reduce((m, r) => (r.p50 < m.p50 ? r : m), rows[0]).id : null;
    return { rows, tightest };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.frame, d.venueToggles, d.venues, d.theme]);

  // hint: active propAMM venues without a selected-size quote should read as
  // unavailable/thin liquidity, not as a broken chart.
  const hint = useMemo(() => {
    const q = d.quotes; if (!q) return null;
    const notes = active.filter((v) => v.role === 'venue').map((v) => {
      if (q.rows.some((r) => r.venueId === v.id && r.market === pair && r.sizeUsd === size)) return null;
      const at = SIZES_USD.filter((s) => q.rows.some((r) => r.venueId === v.id && r.market === pair && r.sizeUsd === s));
      return at.length
        ? `${v.name} quotes ${pair} at ${at.map(sizeLabel).join(' / ')}, not ${sizeLabel(size)}`
        : `${v.name} has no live ${pair} quote`;
    }).filter(Boolean);
    return notes.length ? notes.join(' · ') : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.quotes, d.venueToggles, d.venues, pair, size, d.frame, d.theme]);

  return (
    <div>
      <div style={{ padding: '18px 18px 10px' }}>
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.06em' }}>REALTIME EXECUTION COMPARISON</div>
        <div style={{ fontSize: 11, color: C.dim3, marginTop: 6, lineHeight: 1.55, maxWidth: 880 }}>
          Last 60s of quotes for the selected pair at the chosen notional. Spreads are quoted vs the <span style={{ color: C.text3 }}>{refName}</span> reference BBO mid.{' '}
          <span style={{ color: C.text3 }}>{refLabel}</span> walks the live book for the requested size and overlays the configured taker fee ({taker} bps each side) — realized-vs-realized, the only honest comparison for size-sensitive flow.
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
              {chips.map((v) => {
                const on = d.venueToggles[v.id];
                const color = venueColor(v, d.theme);
                const label = v.name.toUpperCase();
                return (
                  <div key={v.id} onClick={() => d.toggleVenue(v.id)} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 4, cursor: 'pointer',
                    fontSize: 11, whiteSpace: 'nowrap',
                    border: `1px solid ${on ? hexA(color, 0.5) : 'var(--pill-border)'}`,
                    color: on ? C.text : C.faint2, background: on ? hexA(color, 0.12) : 'transparent',
                  }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: on ? color : C.ghost }} />
                    {label}
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
          right={<div style={{ fontSize: 9, color: C.faint2 }}>solid = ask · dashed = bid · ★ = tightest · vs CEX = realized buy vs {refName} (+ = worse)</div>} />
        {/* flex row: the plot ends where the legend column begins, so quotes can
            never render underneath it (no absolute overlay). The canvas re-measures
            its own clientWidth each repaint, so it adapts to the narrower slot. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', padding: '8px 8px 4px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <QuoteCanvas />
          </div>
          {/* width/vs-CEX column is our approved divergence; venue names come
              straight from the registry. Layout matches the design. */}
          <div style={{ flex: 'none', width: 334, margin: '6px 8px 0 14px', background: C.overlay, border: `1px solid ${C.line}`, padding: '8px 10px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 42px 42px 42px 50px', gap: '2px 6px', fontSize: 8.5, color: C.faint2, letterSpacing: '.05em', paddingBottom: 5, borderBottom: `1px solid ${C.line}` }}>
              <div>VENUE</div><div style={{ textAlign: 'right' }}>SPREAD</div><div style={{ textAlign: 'right' }}>BID</div><div style={{ textAlign: 'right' }}>ASK</div><div style={{ textAlign: 'right' }}>vs CEX</div>
            </div>
            {legend.map((r) => (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1fr 42px 42px 42px 50px', gap: '2px 6px', fontSize: 11, padding: '4px 0', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flex: 'none' }} />
                  <span style={{ color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{r.name}</span>
                  {/* keep the venue cell on ONE line so the numeric cells stay aligned across rows
                      (a wrapped name grows the row and drops the numbers below the name's baseline).
                      one-sided venues need no badge — the n/a bid/ask already shows it. */}
                  {!r.full
                    ? <span title="liquidity exhausts before the full notional — the price shown is for a partial fill, not executable at the full size" style={{ flex: 'none', fontSize: 7.5, color: C.amber, border: `1px solid color-mix(in srgb, var(--amber) 45%, transparent)`, borderRadius: 3, padding: '0 3px', letterSpacing: '.04em' }}>PARTIAL</span>
                    : r.id === tight
                      ? <span style={{ flex: 'none', fontSize: 9, color: C.green }}>★</span>
                      : null}
                </div>
                <div style={{ textAlign: 'right', color: r.oneSided || !r.full ? C.faint2 : r.id === tight ? C.green : C.text, fontWeight: 600 }}>{r.oneSided ? '—' : r.spread.toFixed(2)}</div>
                <div style={{ textAlign: 'right', color: r.hasBid ? C.red : C.faint2 }}>{r.hasBid ? sgn(r.bid) : 'n/a'}</div>
                <div style={{ textAlign: 'right', color: r.hasAsk ? C.green : C.faint2 }}>{r.hasAsk ? sgn(r.ask) : 'n/a'}</div>
                <div style={{ textAlign: 'right', color: r.vsCex == null ? C.faint2 : r.vsCex > 0.05 ? C.red : r.vsCex < -0.05 ? C.green : C.dim, fontWeight: 600 }}>
                  {r.vsCex == null ? '—' : sgn(r.vsCex)}
                </div>
              </div>
            ))}
          </div>
        </div>
        {hint && (
          <div style={{ padding: '0 14px 10px', fontSize: 9.5, color: C.faint2, lineHeight: 1.5 }}>
            ⓘ {hint}
          </div>
        )}
      </Panel>

      {/* BID_ASK_DEPTH */}
      <Panel style={{ margin: '0 18px 14px' }}>
        <PanelHead icon="≡" title="BID_ASK_DEPTH" sub={`${pair} · spread vs ${refName} mid (bps) by trade size`} />
        <div style={{ padding: '16px 18px 8px' }}>
          <div style={{ display: 'flex', paddingLeft: 64, marginBottom: 10 }}>
            <div style={{ flex: 1, textAlign: 'center', fontSize: 9, color: C.faint2, letterSpacing: '.1em' }}>BIDS — below mid</div>
            <div style={{ flex: 1, textAlign: 'center', fontSize: 9, color: C.faint2, letterSpacing: '.1em' }}>ASKS — above mid</div>
          </div>
          {depth.map((rowd) => (
            <div key={rowd.label} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34, background: rowd.highlight ? 'var(--accent-row)' : undefined }}>
              <div style={{ width: 54, textAlign: 'right', fontSize: 11, color: C.dim }}>{rowd.label}</div>
              <div style={{ position: 'relative', flex: 1, height: 20 }}>
                <div style={{ position: 'absolute', left: '50%', top: -3, bottom: -3, width: 1, background: 'var(--green-line)', zIndex: 5 }} />
                {rowd.segsBid.map((s, i) => <div key={'b' + i} style={{ position: 'absolute', top: 2, height: 16, right: '50%', width: `${s.w.toFixed(2)}%`, background: hexA(s.color, s.full ? 0.9 : 0.32), borderRadius: '2px 0 0 2px' }} />)}
                {rowd.segsAsk.map((s, i) => <div key={'a' + i} style={{ position: 'absolute', top: 2, height: 16, left: '50%', width: `${s.w.toFixed(2)}%`, background: hexA(s.color, s.full ? 0.9 : 0.32), borderRadius: '0 2px 2px 0' }} />)}
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
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr repeat(7, 1fr) 0.8fr', gap: 6, padding: '8px 6px', fontSize: 11.5, borderBottom: `1px solid ${C.line3}`, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flex: 'none' }} />
                <span style={{ color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{r.name}</span>
                {r.id === stats.tightest ? <span style={{ flex: 'none', fontSize: 9, color: C.green }}>★</span> : null}
              </div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p5.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p25.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: r.id === stats.tightest ? C.green : C.text, fontWeight: 600 }}>{r.p50.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p75.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim }}>{r.p95.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim3 }}>{r.avg.toFixed(3)}</div>
              <div style={{ textAlign: 'right', color: C.dim3 }}>{r.sd.toFixed(4)}</div>
              <div style={{ textAlign: 'right', color: C.faint2 }}>{r.n}</div>
            </div>
          ))}
          <div style={{ fontSize: 9, color: C.faint3, marginTop: 9 }}>p50 = median round-trip spread (bps, bid/ask vs the {refName} MONUSDT mid) · σ = spread stdev · ★ = tightest p50 in window</div>
        </div>
      </Panel>
    </div>
  );
}
