import { useEffect, useRef } from 'react';
import { VENUE_COLOR, type Venue } from '@shared';
import { useDashboard, VENUES } from '../store';
import { hexA } from '../theme';

const N = 120;

/** Streaming bid/ask quote chart — a port of DCLogic.draw(): step-area lines per
 *  venue (solid = ask, dashed = bid), price grid, and a -60s..0 time axis. */
export function QuoteCanvas() {
  const d = useDashboard();
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 58, padR = 10, padT = 12, padB = 22;
    const active = VENUES.filter((v) => d.venues[v]);
    if (!active.length) return;

    let mn = Infinity, mx = -Infinity;
    for (const v of active) {
      const s = d.series[v];
      for (const p of s.bid) { if (p < mn) mn = p; if (p > mx) mx = p; }
      for (const p of s.ask) { if (p < mn) mn = p; if (p > mx) mx = p; }
    }
    if (!isFinite(mn) || mn === mx) return;
    const pad = (mx - mn) * 0.12; mn -= pad; mx += pad;

    const X = (i: number) => padL + (i / (N - 1)) * (w - padL - padR);
    const Y = (p: number) => padT + (1 - (p - mn) / (mx - mn)) * (h - padT - padB);

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const p = mn + (mx - mn) * g / 4, y = Y(p);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = '#6b6d76'; ctx.textAlign = 'right'; ctx.fillText(p.toFixed(5), padL - 6, y + 3);
    }
    ctx.textAlign = 'center';
    // time axis spans (N-1) samples at the service's real quote cadence, not a
    // hardcoded 500ms (audit I6).
    const cadenceMs = d.state?.quoteCadenceMs ?? 500;
    const spanSec = ((N - 1) * cadenceMs) / 1000;
    const TICKS = 6;
    for (let k = 0; k <= TICKS; k++) {
      const i = (k / TICKS) * (N - 1), x = X(i);
      const secAgo = Math.round((1 - k / TICKS) * spanSec);
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      ctx.fillStyle = '#5e6068'; ctx.fillText('-' + secAgo + 's', x, h - 7);
    }

    const stepPath = (arr: number[]) => {
      ctx.beginPath();
      arr.forEach((p, i) => {
        const x = X(i), y = Y(p);
        if (!i) ctx.moveTo(x, y);
        else { ctx.lineTo(x, Y(arr[i - 1])); ctx.lineTo(x, y); }
      });
    };

    for (const v of active) {
      const c = VENUE_COLOR[v as Venue], s = d.series[v];
      if (s.ask.length < 2) continue;
      // filled band between ask (top) and bid (bottom)
      ctx.beginPath();
      s.ask.forEach((p, i) => { const x = X(i), y = Y(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      for (let i = s.bid.length - 1; i >= 0; i--) ctx.lineTo(X(i), Y(s.bid[i]));
      ctx.closePath(); ctx.fillStyle = hexA(c, 0.05); ctx.fill();
      // ask solid, bid dashed
      ctx.lineWidth = 1.3; ctx.strokeStyle = c; ctx.setLineDash([]); stepPath(s.ask); ctx.stroke();
      ctx.lineWidth = 1; ctx.setLineDash([3, 3]); stepPath(s.bid); ctx.stroke(); ctx.setLineDash([]);
    }
  }, [d.frame, d.venues, d.pair, d.size, d.series]);

  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: 360 }} />;
}
