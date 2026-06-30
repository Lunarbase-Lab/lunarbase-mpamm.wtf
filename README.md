# propAMM · Monad — execution monitor

A real-time dashboard for **prop AMMs on Monad mainnet** — LFJ Liquidity Book v2.2 (bin AMM)
and Clober V2 (on-chain CLOB) — benchmarked against **Bybit `MONUSDT`** spot. It surfaces four
views: live execution quality, filled volume, swap markouts, and a markout leaderboard.

This is the full-stack implementation of the [`propAMM.dc.html`](design/propAMM.dc.html) design
(see [`spec.md`](spec.md) for the domain model). The design is preserved under [`design/`](design/).

```
┌─────────────┐   Multicall3 eth_call (quotes)   ┌──────────────┐   REST + WS    ┌─────────────┐
│ Monad RPC   │──  getLogs tail (fills) ────────▶│   server/    │───────────────▶│    web/     │
│ Bybit V5 WS │──  MONUSDT book + BBO ──────────▶│ DataSource   │  /api  /stream │ React tabs  │
└─────────────┘                                  └──────────────┘                └─────────────┘
```

## Quick start

```bash
npm install
npm run dev          # backend (live) on :8787 + Vite on :5173 → open http://localhost:5173
```

By default the backend runs **live** — real Monad RPC (Multicall3 quotes + `getLogs` fills) + the
Bybit feed. It fails fast if the chain is unreachable rather than serving fabricated data. To run
fully offline against the deterministic **simulator** (a faithful port of the design's data model,
no external dependencies):

```bash
DATA_SOURCE=sim npm run dev      # or set DATA_SOURCE=sim in .env
```

`npm run typecheck` typechecks both workspaces; `npm run build` builds the frontend.

## Workspaces

| Path        | What                                                                            |
|-------------|---------------------------------------------------------------------------------|
| `shared/`   | The contract: `Quote`/`Fill`/`DailyVolume`/`MarketState` types + verified addresses (spec App. A). |
| `server/`   | Node + TS service. `DataSource` (live / sim), chain + venue layer, Bybit feed, aggregation, SQLite, REST/WS. |
| `web/`      | Vite + React + TS frontend. Four tabs, pixel-faithful to the design, rendering purely off the API. |

## Backend (`server/`)

A single service owns the RPC/WS/Bybit connections and serves a thin frontend (spec D1). It is
built around a `DataSource` interface with two implementations:

- **`LiveDataSource`** — quotes via Multicall3 `eth_call` (LFJ `getSwapOut`, Clober
  `getExpectedOutput`) at block cadence; the Bybit book walked realized-vs-realized at size with
  the taker fee overlaid; fills tailed from `getLogs` (LFJ `Swap`, Clober `Take`) and bucketed
  into UTC-day volume; each fill joined to the Bybit mid for 0/5/10/30/60s markouts.
- **`SimDataSource`** — a server-side port of the design's `DCLogic` simulation, run only when
  `DATA_SOURCE=sim` (offline development / demos).

REST: `GET /api/markets`, `/api/quotes`, `/api/volume`, `/api/fills?days=&limit=`, `/api/health`.
WS `/stream` channels: `state`, `quotes`, `fill`, `volume`.

**What's persisted:** the SQLite DB holds the durable history — daily-volume aggregates, the
`lastProcessedBlock` cursor, and **decoded fills** (expensive to re-derive: log decode + a
Bybit-mid markout join, so they're stored with a retention window rather than re-fetched). The
current quote matrix stays in memory (replace-on-poll, cheap). So the tape / markouts / leaderboard
are served from real history (`/api/fills?days=N`), not just a live buffer.

### Live mode is a persist-forward indexer

The public `https://rpc.monad.xyz` endpoint supports `eth_call` (quotes ✓) and short `getLogs`
ranges (live fill tailing ✓), but **caps `getLogs` to ~100 blocks**, so deep history (from the
Clober deploy block ~31.6M) can't be backfilled at the tip. Rather than depend on a deep archival
replay, live mode **indexes forward** — the SQLite DB is the source of truth for daily-volume
history:

- **Boot:** load persisted days + `lastProcessedBlock` from the DB.
- **Seed (once, cheap):** closed Clober days are filled from the Goldsky subgraph
  (`Σ BookDayData.volumeUSD` = whole-venue, `Σ PoolDayData.volumeUSD` = vault/propAMM cut).
  LFJ has no keyless source, so it **accumulates forward** from first run (set `LFJ_API_KEY` to
  seed it from LFJ analytics).
- **Resume:** a same-day restart gap-fills `getLogs` from `lastProcessedBlock` → tip (no gap);
  a cold start or cross-midnight restart starts forward at the tip.
- **Forward:** every block, decoded fills advance today's bucket and are persisted; a throttled
  snapshot writes the aggregates + cursor + new/aged fills, pruning past the retention window.

So history grows organically and survives restarts, using only public-RPC-friendly recent-range
`getLogs` — no archive node required for ongoing operation. Clober *quotes* still need a recent
book cache (discovery scans a recent window), so they appear only when recent `Open` events exist;
an archive node or a subgraph book-seed would remove that too. The simulator has no such gaps.

## Frontend (`web/`)

`store.tsx` connects to the API (REST cold-start + reconnecting WS), maintains rolling quote
buffers for the canvas, and exposes everything via `useDashboard()`. Each tab computes its
view-model from the contract data:

- **Execution** — streaming bid/ask quote canvas, depth ladder, rolling spread percentiles.
- **Volume** — KPIs, stacked daily notional, cumulative + market-share, protocol breakdown.
- **Markouts** — live swap tape with 0/5/10/30/60s markouts and an outlier feed.
- **Leaderboard** — percentile leaderboard and biggest winners/losers by markout.
