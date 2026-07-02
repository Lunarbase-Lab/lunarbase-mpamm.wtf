import { useMemo } from 'react';
import type { Fill } from '@shared';
import { useDashboard } from '../store';
import { C, COL, SEM, VAULT_LABEL, type Theme } from '../theme';
import { Pills, SideTag } from '../components/ui';
import { fmtUsd, fmtAmt, fmtInt, pnlFmt, percentile, sparkPath, humanAge, shortHex } from '../lib/format';

const HZ_IDX: Record<string, number> = { 'T+0S': 0, 'T+10S': 2, 'T+30S': 3, 'T+60S': 4 };
const DAY = 86_400_000;
const WIN_MS: Record<string, number> = { '24H': DAY, '7D': 7 * DAY, '30D': 30 * DAY };

// PROTOCOL display name + colour (DCLogic.protoCol against the displayProto).
function displayProto(f: Fill): string {
  return f.scope === 'vault' ? VAULT_LABEL.toUpperCase() : f.protocol.toUpperCase();
}
function protoCol(n: string, theme: Theme): string {
  const col = COL[theme];
  return n === 'LFJ' ? col.LFJ : n === 'CLOBER' ? col.Clober : col.Vault;
}
// CATEGORY colour (DCLogic.catCol). The contract's 'DIRECT' maps to the
// design's '—' bucket, which falls through to the faint default.
function catCol(c: string, theme: Theme): string {
  const col = COL[theme];
  return c === 'ROUTER' ? C.amber : c === 'CEX/DEX' ? col.Clober : c === 'AGG' ? col.Vault : C.faint2;
}
// display label for a fill category — DIRECT renders as the em-dash.
function catLabel(c: string): string {
  return c === 'DIRECT' ? '—' : c;
}

// grid templates lifted verbatim from the design (source of truth for pixels).
const LB_GRID = '34px 1.7fr 96px 64px 58px 58px 58px 58px 58px 1.5fr';
const TOP_GRID = '30px 76px 64px 82px 1.3fr 64px 88px 46px 1fr 1fr 76px 56px 80px';

export function LeaderboardTab() {
  const d = useDashboard();
  const fills = d.fills;
  const { lbWin, lbGroup, lbHz, lbMk, lbWinners, lbTop } = d;

  const hzIdx = HZ_IDX[lbHz] ?? 0;
  const sign = lbMk === 'MAKER' ? -1 : 1;

  // real time-window slice over the persisted fills (no extrapolation).
  // propAMM dashboard: keep LFJ + the Clober oracle-vault cut, always dropping
  // independent (whole-venue) Clober flow.
  const windowed = useMemo(() => {
    const since = Date.now() - (WIN_MS[lbWin] ?? WIN_MS['24H']);
    return fills.filter((f) => {
      if (f.ts < since) return false;
      if (f.protocol === 'Clober' && f.scope !== 'vault') return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fills, lbWin, d.frame]);

  // Only fills that have a realized markout at the selected horizon feed the
  // percentile / PnL / sparkline math — never coerce null→0 (audit C2). Exclude
  // pxApprox fills EXPLICITLY (not just via the null-markout proxy): the shared
  // contract says their execPx/markouts are not real execution edge (spec §5.2).
  const windowedHz = useMemo(
    () => windowed.filter((f) => !f.pxApprox && f.markoutsBps[hzIdx] != null),
    [windowed, hzIdx],
  );

  // PROTOCOL_LEADERBOARD rows — grouped + percentiled per DCLogic.lbVals().
  const lbRows = useMemo(() => {
    const keyFn = (f: Fill): string =>
      lbGroup === 'PROTOCOL' ? displayProto(f)
        : lbGroup === 'CATEGORY' ? (f.category === 'DIRECT' ? 'direct' : f.category)
          : lbGroup === 'POOL' ? f.pool
            : f.to;
    const colorFor = (n: string): string =>
      lbGroup === 'PROTOCOL' ? protoCol(n, d.theme)
        : lbGroup === 'CATEGORY' ? catCol(n === 'direct' ? '—' : n, d.theme)
          : COL[d.theme].Vault;

    const groups: Record<string, Fill[]> = {};
    for (const f of windowedHz) {
      const k = keyFn(f);
      (groups[k] = groups[k] ?? []).push(f);
    }
    let arr = Object.entries(groups).map(([k, fs]) => {
      const vol = fs.reduce((a, f) => a + f.usd, 0);
      const mks = fs.map((f) => sign * (f.markoutsBps[hzIdx] ?? 0));
      const pnl = fs.reduce((a, f) => a + (sign * (f.markoutsBps[hzIdx] ?? 0)) / 1e4 * f.usd, 0);
      const ord = [...fs].sort((a, b) => a.ts - b.ts);
      let c = 0;
      const sp = ord.map((f) => { c += (sign * (f.markoutsBps[hzIdx] ?? 0)) / 1e4 * f.usd; return c; });
      return {
        name: k, color: colorFor(k), vol, swaps: fs.length,
        p5: percentile(mks, .05), p25: percentile(mks, .25), p50: percentile(mks, .5),
        p75: percentile(mks, .75), p95: percentile(mks, .95), pnl, sp,
      };
    });
    arr.sort((a, b) => b.vol - a.vol);
    arr = arr.slice(0, 12);
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowedHz, lbGroup, lbMk, d.frame, d.theme]);

  // TOP_SWAPS rows — biggest single-swap winners/losers per DCLogic.lbVals().
  const topRows = useMemo(() => {
    let tsw = windowedHz.map((f) => {
      const mk = sign * (f.markoutsBps[hzIdx] as number);
      return { f, mk, pnl: mk / 1e4 * f.usd };
    });
    tsw = lbWinners
      ? tsw.filter((x) => x.pnl > 0).sort((a, b) => b.pnl - a.pnl)
      : tsw.filter((x) => x.pnl < 0).sort((a, b) => a.pnl - b.pnl);
    return tsw.slice(0, lbTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowedHz, lbMk, lbWinners, lbTop, d.frame]);

  // percentile cell — '+'/'' + toFixed(2), green > 0.02 / red < -0.02 / dim.
  const pcell = (v: number) => ({
    txt: (v >= 0 ? '+' : '') + v.toFixed(2),
    color: v > 0.02 ? C.green : v < -0.02 ? C.red : C.dim,
  });

  const groupLbl = lbGroup.toLowerCase();

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '18px 18px 12px' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.06em', color: C.text }}>MARKOUT LEADERBOARD</div>
          <div style={{ fontSize: 11, color: C.dim3, marginTop: 6, lineHeight: 1.55, maxWidth: 760 }}>
            Percentile distribution of markouts and the biggest single-swap winners / losers, per group, over the selected window. Markouts vs Bybit MONUSDT BBO mid; pool PnL = Σ(markout_bps × size_usd / 10000).
          </div>
        </div>
        <Pills options={['24H', '7D', '30D']} value={lbWin} onChange={(v) => d.set('lbWin', v)} sm />
      </div>

      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', padding: '2px 18px 16px', fontSize: 9, color: C.faint2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ letterSpacing: '.06em' }}>GROUP BY</span>
          <Pills options={['PROTOCOL', 'POOL', 'TO ADDRESS', 'CATEGORY']} value={lbGroup} onChange={(v) => d.set('lbGroup', v)} sm />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ letterSpacing: '.06em' }}>HORIZON</span>
          <Pills options={['T+0S', 'T+10S', 'T+30S', 'T+60S']} value={lbHz} onChange={(v) => d.set('lbHz', v)} sm />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ letterSpacing: '.06em' }}>MARKOUTS</span>
          <Pills options={['TAKER', 'MAKER']} value={lbMk} onChange={(v) => d.set('lbMk', v)} sm />
        </div>
        <div onClick={() => d.resetLb()} style={{
          marginLeft: 'auto', padding: '3px 9px', border: '1px solid var(--pill-border)', borderRadius: 4,
          cursor: 'pointer', fontSize: 10, color: C.dim2,
        }}>RESET FILTERS</div>
      </div>

      {/* PROTOCOL_LEADERBOARD */}
      <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
        <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
        <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />
        <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em' }}>
          <span style={{ color: C.purple }}>$</span>{' '}
          <span style={{ color: C.text, fontWeight: 600 }}>LEADERBOARD_{lbWin}</span>{' '}
          <span style={{ color: C.faint }}>grouped by {groupLbl} · markout {lbHz}</span>
        </div>
        <div style={{ padding: '4px 14px 12px', overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: LB_GRID, gap: '0 8px', padding: '9px 6px', fontSize: 9, color: C.faint2, letterSpacing: '.04em', borderBottom: `1px solid ${C.line}`, minWidth: 980 }}>
            <div>#</div><div>{lbGroup}</div>
            <div style={{ textAlign: 'right' }}>VOLUME</div><div style={{ textAlign: 'right' }}>SWAPS</div>
            <div style={{ textAlign: 'right' }}>P5</div><div style={{ textAlign: 'right' }}>P25</div><div style={{ textAlign: 'right' }}>P50</div>
            <div style={{ textAlign: 'right' }}>P75</div><div style={{ textAlign: 'right' }}>P95</div><div style={{ textAlign: 'right' }}>POOL PNL</div>
          </div>
          {lbRows.map((g, i) => {
            const cells = [g.p5, g.p25, g.p50, g.p75, g.p95].map(pcell);
            return (
              <div key={g.name + i} style={{ display: 'grid', gridTemplateColumns: LB_GRID, gap: '0 8px', padding: '11px 6px', fontSize: 11.5, borderBottom: `1px solid ${C.line3}`, alignItems: 'center', minWidth: 980 }}>
                <div style={{ color: C.faint2 }}>{String(i + 1).padStart(2, '0')}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: g.color, flex: 'none' }} />
                  <span style={{ color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</span>
                </div>
                <div style={{ textAlign: 'right', color: C.text }}>{fmtUsd(g.vol)}</div>
                <div style={{ textAlign: 'right', color: C.dim }}>{fmtInt(g.swaps)}</div>
                {cells.map((c, k) => (
                  <div key={k} style={{ textAlign: 'right', color: c.color }}>{c.txt}</div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
                  <span style={{ color: g.pnl >= 0 ? C.green : C.red, fontWeight: 600 }}>{pnlFmt(g.pnl)}</span>
                  <svg width="130" height="26" viewBox="0 0 130 26" preserveAspectRatio="none" style={{ flex: 'none' }}>
                    {/* resolved rgb (not var()) so it's valid as an SVG stroke attribute */}
                    <path d={sparkPath(g.sp, 130, 26)} fill="none" stroke={g.pnl >= 0 ? SEM[d.theme].green.css : SEM[d.theme].red.css} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                  </svg>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* TOP_SWAPS */}
      <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, margin: '0 18px 14px' }}>
        <i style={{ position: 'absolute', top: -1, left: -1, width: 8, height: 8, borderTop: `1px solid ${C.purple}`, borderLeft: `1px solid ${C.purple}` }} />
        <i style={{ position: 'absolute', bottom: -1, right: -1, width: 8, height: 8, borderBottom: `1px solid ${C.purple}`, borderRight: `1px solid ${C.purple}` }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '9px 12px', borderBottom: `1px solid ${C.line2}` }}>
          <div style={{ fontSize: 11, letterSpacing: '.03em' }}>
            <span style={{ color: C.purple }}>−</span>{' '}
            <span style={{ color: C.text, fontWeight: 600 }}>TOP_SWAPS_BY_MARKOUT_USD</span>{' '}
            <span style={{ color: C.faint }}>{lbHz} markout · {lbWin} window</span>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ display: 'flex', gap: 3 }}>
              <div onClick={() => d.set('lbWinners', true)} style={wlBtn(lbWinners, SEM[d.theme].green)}>WINNERS</div>
              <div onClick={() => d.set('lbWinners', false)} style={wlBtn(!lbWinners, SEM[d.theme].red)}>LOSERS</div>
            </div>
            <Pills
              options={[{ label: 'TOP 10', value: 10 }, { label: 'TOP 25', value: 25 }, { label: 'TOP 50', value: 50 }]}
              value={lbTop} onChange={(v) => d.set('lbTop', v)} sm
            />
          </div>
        </div>
        <div style={{ padding: '0 14px 12px', overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: TOP_GRID, gap: '0 8px', padding: '9px 6px', fontSize: 8.5, color: C.faint2, letterSpacing: '.04em', borderBottom: `1px solid ${C.line}`, minWidth: 1140 }}>
            <div>#</div><div>BLOCK</div><div>AGE</div><div>TX</div><div>TO</div><div>CATEGORY</div><div>POOL</div><div>SIDE</div>
            <div style={{ textAlign: 'right' }}>IN</div><div style={{ textAlign: 'right' }}>OUT</div><div style={{ textAlign: 'right' }}>EXEC PX</div>
            <div style={{ textAlign: 'right' }}>MK BPS</div><div style={{ textAlign: 'right' }}>MK $</div>
          </div>
          {topRows.map((x, i) => {
            const f = x.f;
            const base = f.usd / f.execPx;
            const stable = f.market.split('/')[1];
            const buy = f.side.toLowerCase() === 'buy';
            const inAmt = buy ? fmtAmt(f.usd) + ' ' + stable : fmtAmt(base) + ' MON';
            const outAmt = buy ? fmtAmt(base) + ' MON' : fmtAmt(f.usd) + ' ' + stable;
            return (
              <div key={f.id} style={{ display: 'grid', gridTemplateColumns: TOP_GRID, gap: '0 8px', padding: '8px 6px', fontSize: 10.5, borderBottom: `1px solid ${C.hair}`, alignItems: 'center', minWidth: 1140 }}>
                <div style={{ color: C.faint2 }}>{String(i + 1).padStart(2, '0')}</div>
                <div style={{ color: C.dim3 }}>{fmtInt(f.blockNumber)}</div>
                <div style={{ color: C.faint2 }}>{humanAge((Date.now() - f.ts) / 1000)}</div>
                <div style={{ color: C.link }}>{shortHex(f.txHash)}</div>
                <div style={{ color: C.dim3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.to}</div>
                <div style={{ color: catCol(f.category, d.theme), fontSize: 9 }}>{catLabel(f.category)}</div>
                <div style={{ color: C.faint2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.pool}</div>
                <div><SideTag side={f.side} /></div>
                <div style={{ textAlign: 'right', color: C.dim }}>{inAmt}</div>
                <div style={{ textAlign: 'right', color: C.dim }}>{outAmt}</div>
                <div style={{ textAlign: 'right', color: C.text2 }}>{f.execPx.toFixed(5)}</div>
                <div style={{ textAlign: 'right', color: x.mk >= 0 ? C.green : C.red }}>{(x.mk >= 0 ? '+' : '') + x.mk.toFixed(2)}</div>
                <div style={{ textAlign: 'right', color: x.pnl >= 0 ? C.green : C.red, fontWeight: 600 }}>{pnlFmt(x.pnl)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// WINNERS/LOSERS toggle button (DCLogic.wlBtn) — themed via SEM (rgb for the
// translucent border/bg, css for the text).
function wlBtn(active: boolean, sem: { css: string; rgb: string }): React.CSSProperties {
  return {
    padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 10,
    border: `1px solid ${active ? `rgba(${sem.rgb},.53)` : 'var(--pill-border)'}`,
    background: active ? `rgba(${sem.rgb},.13)` : 'transparent',
    color: active ? sem.css : C.dim2,
  };
}
