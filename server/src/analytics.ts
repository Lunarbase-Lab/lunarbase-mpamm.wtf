import {
  LEADERBOARD_HORIZON_IDX, LEADERBOARD_GROUPINGS, percentile,
  type Fill, type LeaderboardResponse, type LeaderboardGroupRow,
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
 *
 * Async on purpose: a 30d window is hundreds of thousands of rows and the
 * production box is small (0.5 vCPU — an uncached 30d pass measured ~15s when
 * this was synchronous, stalling the quote stream for everyone). The
 * accumulation loop YIELDS to the event loop every YIELD_EVERY rows so quote
 * ticks and WS broadcasts keep flowing while it runs.
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

const TOP_GROUPS = 12;      // the UI renders the top 12 groups by volume
const TOP_SWAPS = 50;       // max TOP_SWAPS pill (TOP 10/25/50)
const OUTLIERS = 18;        // OUTLIER_FEED depth (Markouts tab)
const SPARK_POINTS = 80;    // downsampled cumulative-PnL sparkline length
const YIELD_EVERY = 20_000; // rows per event-loop slice (~tens of ms each)

/** per-(grouping, horizon, key) accumulator. `mks`/`pnlSteps` are pushed in ts
 *  order (rows come sorted), so the spark is a cumsum over pnlSteps. */
interface Acc { vol: number; swaps: number; mks: number[]; pnlSteps: number[] }

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

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Aggregate one window. `rows` = the window's fills (pxApprox already excluded),
 * any order. `fullFills` resolves ids → full Fill rows for the topSwaps/outlier
 * feeds (a DB lookup for live, an in-memory filter for sim).
 */
export async function computeLeaderboard(
  rows: LbFill[],
  days: number,
  now: number,
  fullFills: (ids: string[]) => Fill[],
): Promise<LeaderboardResponse> {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts); // spark/pnl accumulate in ts order
  const H = LEADERBOARD_HORIZON_IDX;
  const G = LEADERBOARD_GROUPINGS;

  // one pass: per grouping × horizon → Map(key → Acc); plus per horizon a flat
  // (pnl, rowIdx) list for the top-swaps selection. Group keys are computed
  // ONCE per row (not per horizon) — this loop is the hot path.
  const acc: Map<string, Acc>[][] = G.map(() => H.map(() => new Map<string, Acc>()));
  const pnlIdx: Array<Array<{ pnl: number; i: number }>> = H.map(() => []);
  const outlierCand: Array<{ pnl: number; i: number }> = [];
  const daySince = now - 86_400_000;
  const rowKeys: string[] = new Array(G.length);

  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) await yieldLoop();
    const f = sorted[i];
    rowKeys[0] = f.venueId;                                        // protocol
    rowKeys[1] = f.pool;                                           // pool
    rowKeys[2] = f.to;                                             // to
    rowKeys[3] = f.category === 'DIRECT' ? 'direct' : f.category;  // category (client's key)
    for (let h = 0; h < H.length; h++) {
      const mk = f.markoutsBps[H[h]];
      if (mk == null) continue; // no realized markout at this horizon — never coerced to 0
      const pnl = (mk / 1e4) * f.usd;
      pnlIdx[h].push({ pnl, i });
      if (H[h] === 0 && f.ts >= daySince) outlierCand.push({ pnl, i });
      for (let g = 0; g < G.length; g++) {
        const m = acc[g][h];
        let a = m.get(rowKeys[g]);
        if (!a) { a = { vol: 0, swaps: 0, mks: [], pnlSteps: [] }; m.set(rowKeys[g], a); }
        a.vol += f.usd;
        a.swaps += 1;
        a.mks.push(mk);
        a.pnlSteps.push(pnl);
      }
    }
  }

  // group tables: top 12 by volume per (grouping, horizon), stats + spark.
  const groups = {} as LeaderboardResponse['groups'];
  for (let g = 0; g < G.length; g++) {
    const byHz: Record<string, LeaderboardGroupRow[]> = {};
    for (let h = 0; h < H.length; h++) {
      const entries = [...acc[g][h]].sort((a, b) => b[1].vol - a[1].vol);
      byHz[String(H[h])] = entries.slice(0, TOP_GROUPS).map(([key, a]) => ({
        key,
        vol: a.vol,
        swaps: a.swaps,
        p5: percentile(a.mks, 0.05), p25: percentile(a.mks, 0.25), p50: percentile(a.mks, 0.5),
        p75: percentile(a.mks, 0.75), p95: percentile(a.mks, 0.95),
        pnl: a.pnlSteps.reduce((s, v) => s + v, 0),
        spark: sparkOf(a.pnlSteps),
      }));
      await yieldLoop(); // percentile sorts over big groups are the other heavy step
    }
    groups[G[g]] = byHz;
  }

  // top swaps per horizon: strict winners (pnl > 0) desc / losers (pnl < 0) asc —
  // identical filters + ordering to the client's old lbVals().
  const wantIds = new Set<string>();
  const topSel: Array<{ winners: Array<{ i: number }>; losers: Array<{ i: number }> }> = [];
  for (let h = 0; h < H.length; h++) {
    const winners = pnlIdx[h].filter((x) => x.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, TOP_SWAPS);
    const losers = pnlIdx[h].filter((x) => x.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, TOP_SWAPS);
    for (const x of winners) wantIds.add(sorted[x.i].id);
    for (const x of losers) wantIds.add(sorted[x.i].id);
    topSel.push({ winners, losers });
    await yieldLoop();
  }
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
