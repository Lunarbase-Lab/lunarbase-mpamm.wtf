import {
  LEADERBOARD_HORIZON_IDX, LEADERBOARD_GROUPINGS, percentile,
  type Fill, type LeaderboardResponse, type LeaderboardGroupRow, type LeaderboardGrouping,
} from '@shared';

/**
 * Server-side leaderboard aggregation (spec §4.4).
 *
 * The tabs used to ship raw fills to the browser and aggregate there — which
 * silently truncated the 7D/30D windows at the fetch cap (~20k fills ≈ <2 days
 * at Metric's fill rate). This computes the SAME stats the client did (same
 * percentile fn, same filters, same ordering) over the FULL window, next to the
 * rows. Everything is TAKER-signed; the MAKER view is a pure sign flip the
 * client derives, so nothing is computed twice.
 */

/** The light row shape the aggregation needs — `Fill` satisfies it structurally,
 *  and the live source materializes exactly these columns from SQLite. */
export interface LbFill {
  id: string;
  ts: number;
  venueId: string;
  category: string;
  pool: string;
  to: string;
  usd: number;
  markoutsBps: (number | null)[];
}

const TOP_GROUPS = 12;   // the UI renders the top 12 groups by volume
const TOP_SWAPS = 50;    // max TOP_SWAPS pill (TOP 10/25/50)
const OUTLIERS = 18;     // OUTLIER_FEED depth (Markouts tab)
const SPARK_POINTS = 80; // downsampled cumulative-PnL sparkline length

/** per-(grouping, key, horizon) accumulator. `mks`/`pnlSteps` are pushed in ts
 *  order (rows come sorted), so the spark is a cumsum over pnlSteps. */
interface Acc { vol: number; swaps: number; mks: number[]; pnlSteps: number[] }

const groupKey: Record<LeaderboardGrouping, (f: LbFill) => string> = {
  protocol: (f) => f.venueId,
  pool: (f) => f.pool,
  to: (f) => f.to,
  // DIRECT renders as 'direct' — the exact key the client-side grouping used.
  category: (f) => (f.category === 'DIRECT' ? 'direct' : f.category),
};

/** cumsum of `steps`, downsampled to ≤ SPARK_POINTS (always keeps the final
 *  total). The sparkline only needs the shape — per-fill resolution at 30d
 *  (~10⁵ points) would dominate the payload for no visual gain. */
function sparkOf(steps: number[]): number[] {
  const stride = Math.max(1, Math.ceil(steps.length / SPARK_POINTS));
  const out: number[] = [];
  let c = 0;
  for (let i = 0; i < steps.length; i++) {
    c += steps[i];
    if ((i + 1) % stride === 0 || i === steps.length - 1) out.push(c);
  }
  return out;
}

/**
 * Aggregate one window. `rows` = the window's fills (pxApprox already excluded),
 * any order. `fullFills` resolves ids → full Fill rows for the topSwaps/outlier
 * feeds (a DB lookup for live, an in-memory filter for sim).
 */
export function computeLeaderboard(
  rows: LbFill[],
  days: number,
  now: number,
  fullFills: (ids: string[]) => Fill[],
): LeaderboardResponse {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts); // spark/pnl accumulate in ts order
  const H = LEADERBOARD_HORIZON_IDX;

  // one pass: per grouping × horizon × key → {vol, swaps, mks, pnlSteps};
  // plus per horizon a flat (pnl, rowIdx) list for the top-swaps selection.
  const acc = new Map<string, Acc>(); // "g|hzIdx|key"
  const pnlIdx: Array<Array<{ pnl: number; i: number }>> = H.map(() => []);
  const outlierCand: Array<{ pnl: number; i: number }> = [];
  const daySince = now - 86_400_000;

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    for (let h = 0; h < H.length; h++) {
      const mk = f.markoutsBps[H[h]];
      if (mk == null) continue; // no realized markout at this horizon — never coerced to 0
      const pnl = (mk / 1e4) * f.usd;
      pnlIdx[h].push({ pnl, i });
      if (H[h] === 0 && f.ts >= daySince) outlierCand.push({ pnl, i });
      for (const g of LEADERBOARD_GROUPINGS) {
        const k = `${g}|${H[h]}|${groupKey[g](f)}`;
        let a = acc.get(k);
        if (!a) { a = { vol: 0, swaps: 0, mks: [], pnlSteps: [] }; acc.set(k, a); }
        a.vol += f.usd;
        a.swaps += 1;
        a.mks.push(mk);
        a.pnlSteps.push(pnl);
      }
    }
  }

  // group tables: top 12 by volume per (grouping, horizon), stats + spark.
  const groups = {} as LeaderboardResponse['groups'];
  for (const g of LEADERBOARD_GROUPINGS) {
    const byHz: Record<string, LeaderboardGroupRow[]> = {};
    for (const hz of H) {
      const prefix = `${g}|${hz}|`;
      const entries: Array<[string, Acc]> = [];
      for (const [k, a] of acc) if (k.startsWith(prefix)) entries.push([k.slice(prefix.length), a]);
      entries.sort((a, b) => b[1].vol - a[1].vol);
      byHz[String(hz)] = entries.slice(0, TOP_GROUPS).map(([key, a]) => ({
        key,
        vol: a.vol,
        swaps: a.swaps,
        p5: percentile(a.mks, 0.05), p25: percentile(a.mks, 0.25), p50: percentile(a.mks, 0.5),
        p75: percentile(a.mks, 0.75), p95: percentile(a.mks, 0.95),
        pnl: a.pnlSteps.reduce((s, v) => s + v, 0),
        spark: sparkOf(a.pnlSteps),
      }));
    }
    groups[g] = byHz;
  }

  // top swaps per horizon: strict winners (pnl > 0) desc / losers (pnl < 0) asc —
  // identical filters + ordering to the client's old lbVals().
  const wantIds = new Set<string>();
  const topSel = H.map((_, h) => {
    const winners = pnlIdx[h].filter((x) => x.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, TOP_SWAPS);
    const losers = pnlIdx[h].filter((x) => x.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, TOP_SWAPS);
    for (const x of winners) wantIds.add(sorted[x.i].id);
    for (const x of losers) wantIds.add(sorted[x.i].id);
    return { winners, losers };
  });
  const outSel = outlierCand.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, OUTLIERS);
  for (const x of outSel) wantIds.add(sorted[x.i].id);

  const byId = new Map<string, Fill>();
  for (const f of fullFills([...wantIds])) byId.set(f.id, f);
  const resolve = (sel: Array<{ i: number }>): Fill[] =>
    sel.map((x) => byId.get(sorted[x.i].id)).filter((f): f is Fill => f != null);

  const topSwaps: LeaderboardResponse['topSwaps'] = {};
  H.forEach((hz, h) => { topSwaps[String(hz)] = { winners: resolve(topSel[h].winners), losers: resolve(topSel[h].losers) }; });

  return {
    days,
    generatedAt: now,
    totalFills: rows.length,
    groups,
    topSwaps,
    outliers: resolve(outSel),
  };
}
