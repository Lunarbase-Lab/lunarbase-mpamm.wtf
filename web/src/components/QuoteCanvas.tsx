import { useEffect, useRef } from 'react';
import { type VenueMeta } from '@shared';
import { useDashboard } from '../store';
import { hexA, venueColor, CH } from '../theme';

const N = 120;

/**
 * Streaming bid/ask QUOTE chart — a STEP (staircase) chart, because quotes are
 * discrete events (one sample per poll/block): hold each sample flat until the
 * next, then step. No smoothing / linear interpolation. Per venue: solid ask +
 * dashed bid step lines and a translucent stepped ribbon between them; the
 * widest-spread venues' fills paint first (underneath) so tighter venues stay
 * legible, then all strokes on top. Port of the design's draw() (data-quote).
 *
 * Reliability (design parity): repaint is driven by the data cadence (`d.frame`)
 * — which survives tab unmount/remount — plus a mount rAF + setTimeout backup for
 * late layout and a resize handler; the canvas ref self-heals via the
 * `data-quote` marker if it's missing or detached.
 */
export function QuoteCanvas() {
  const d = useDashboard();
  const ref = useRef<HTMLCanvasElement | null>(null);
  const paintRef = useRef<() => void>(() => {});

  // rebuilt every render so it closes over the latest series / selection
  paintRef.current = () => {
    // self-heal a missing/detached ref (racy mount, or a stale node after a
    // tab-away-and-back) by re-acquiring the marked canvas.
    let cv = ref.current;
    if (!cv || !cv.isConnected) cv = ref.current = document.querySelector('canvas[data-quote]');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return; // laid out yet? the mount backup retries
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 58, padR = 10, padT = 12, padB = 22;
    const ch = CH[d.theme]; // theme-aware canvas chrome colors (can't use var())
    // propAMM venues + the selected pair's CEX reference (Bybit for MON, Binance for
    // BTC/ETH), filtered by the user's toggles. Everything comes from the registry.
    const cexRef = d.referenceFor(d.pair);
    const chips: VenueMeta[] = [...d.displayVenues, ...d.baselines, ...(cexRef ? [cexRef] : [])];
    const active = chips.filter((v) => d.venueToggles[v.id]);
    if (!active.length) return;

    let mn = Infinity, mx = -Infinity;
    for (const v of active) {
      const s = d.series[v.id];
      if (!s) continue;
      for (const p of s.bid) { if (p < mn) mn = p; if (p > mx) mx = p; }
      for (const p of s.ask) { if (p < mn) mn = p; if (p > mx) mx = p; }
    }
    if (!isFinite(mn) || mn === mx) return;
    const pad = (mx - mn) * 0.12; mn -= pad; mx += pad;

    const X = (i: number) => padL + (i / (N - 1)) * (w - padL - padR);
    const Y = (p: number) => padT + (1 - (p - mn) / (mx - mn)) * (h - padT - padB);

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.lineWidth = 1;
    // adaptive precision so a label always FITS the axis gutter — toFixed(5) on a
    // 5-digit price (BTC ~62,000) is 11 chars, wider than padL, and the leading
    // digit clips off-canvas ("62210.02" rendered as "2210.02").
    const fmtPx = (p: number) => (p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(3) : p.toFixed(5));
    for (let g = 0; g <= 4; g++) {
      const p = mn + (mx - mn) * g / 4, y = Y(p);
      ctx.strokeStyle = ch.grid;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = ch.label; ctx.textAlign = 'right'; ctx.fillText(fmtPx(p), padL - 6, y + 3);
    }
    ctx.textAlign = 'center';
    // time axis spans (N-1) samples at the service's real quote cadence (audit I6).
    const cadenceMs = d.state?.quoteCadenceMs ?? 500;
    const spanSec = ((N - 1) * cadenceMs) / 1000;
    const TICKS = 6;
    for (let k = 0; k <= TICKS; k++) {
      const i = (k / TICKS) * (N - 1), x = X(i);
      const secAgo = Math.round((1 - k / TICKS) * spanSec);
      ctx.strokeStyle = ch.grid2;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      ctx.fillStyle = ch.label2; ctx.fillText('-' + secAgo + 's', x, h - 7);
    }

    const stepPath = (arr: number[]) => {
      ctx.beginPath();
      arr.forEach((p, i) => {
        const x = X(i), y = Y(p);
        if (!i) ctx.moveTo(x, y);
        else { ctx.lineTo(x, Y(arr[i - 1])); ctx.lineTo(x, y); } // hold, then step
      });
    };

    // FILLS first — widest-spread band underneath so tighter venues stay legible.
    const spreadOf = (v: VenueMeta) => {
      const r = d.quotes?.rows.find((x) => x.venueId === v.id && x.market === d.pair && x.sizeUsd === d.size);
      return r ? Math.abs(r.spreadBps) : Infinity; // no live quote → treat as widest (underneath)
    };
    const byW = [...active].sort((a, b) => spreadOf(b) - spreadOf(a));
    for (const v of byW) {
      const s = d.series[v.id];
      if (!s) continue;
      const n = Math.min(s.ask.length, s.bid.length);
      if (n < 2) continue; // need both sides for a ribbon (one-sided venues skip)
      ctx.beginPath();
      ctx.moveTo(X(0), Y(s.ask[0]));
      for (let i = 1; i < n; i++) { ctx.lineTo(X(i), Y(s.ask[i - 1])); ctx.lineTo(X(i), Y(s.ask[i])); } // stepped top (ask)
      ctx.lineTo(X(n - 1), Y(s.bid[n - 1]));
      for (let i = n - 1; i > 0; i--) { ctx.lineTo(X(i - 1), Y(s.bid[i])); ctx.lineTo(X(i - 1), Y(s.bid[i - 1])); } // stepped bottom (bid)
      ctx.closePath();
      // baseline (standard-DEX) venues render as a HEAVIER cost-envelope band —
      // the design's ribbonB — so the propAMM lines visibly sit inside it.
      ctx.fillStyle = hexA(venueColor(v, d.theme), v.role === 'baseline' ? ch.ribbonB : ch.ribbon); ctx.fill();
    }

    // STROKES on top — solid stepped ask, dashed stepped bid (each side drawn
    // independently so a one-sided venue still shows its real line).
    for (const v of active) {
      const s = d.series[v.id];
      if (!s) continue;
      const bench = v.role === 'baseline'; // heavier strokes frame the band (design)
      ctx.strokeStyle = venueColor(v, d.theme);
      if (s.ask.length >= 2) { ctx.lineWidth = bench ? 1.9 : 1.5; ctx.setLineDash([]); stepPath(s.ask); ctx.stroke(); }
      if (s.bid.length >= 2) { ctx.lineWidth = bench ? 1.4 : 1.1; ctx.setLineDash([3, 3]); stepPath(s.bid); ctx.stroke(); ctx.setLineDash([]); }
    }
  };

  // repaint on the data cadence + on venue/pair/size/theme changes (survives remount)
  useEffect(() => { paintRef.current(); }, [d.frame, d.venueToggles, d.venues, d.pair, d.size, d.series, d.theme]);

  // mount: paint now + backups for late layout, and repaint on resize
  useEffect(() => {
    const p = () => paintRef.current();
    p();
    const raf = requestAnimationFrame(p);
    const t = setTimeout(p, 80);
    window.addEventListener('resize', p);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); window.removeEventListener('resize', p); };
  }, []);

  return <canvas ref={ref} data-quote="1" style={{ display: 'block', width: '100%', height: 360 }} />;
}
