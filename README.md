# propAMM · Monad — execution monitor

A real-time dashboard for **propAMMs on Monad mainnet** — oracle/MM-priced venues only
(**LFJ POE**, **Metric**, **Clober Vault**), a composable adapter per protocol. Each pair is
benchmarked against its **own CEX reference** — Bybit `MONUSDT` for MON, Binance (VIP9 taker)
`BTCUSDT`/`ETHUSDT` for BTC/ETH — **converted into the pair's own terms** (live `USDCUSDT`
stable cross + `WBTCBTC` wrapped/native basis, never a $1 peg). It surfaces four views: live
execution quality, filled volume, swap markouts, and a markout leaderboard.

This is the full-stack implementation of the [`propAMM.dc.html`](design/propAMM.dc.html) design
(see [`spec.md`](spec.md) for the domain model). The design is preserved under [`design/`](design/).

```
┌──────────────┐   Multicall3 eth_call (quotes)   ┌──────────────┐   REST + WS    ┌─────────────┐
│ Monad RPC    │──  getLogs tail (fills) ────────▶│   server/    │───────────────▶│    web/     │
│ Bybit V5 WS  │──  MONUSDT book + crosses ──────▶│ DataSource   │  /api  /stream │ React tabs  │
│ Binance WS   │──  BTC/ETH books + WBTCBTC ─────▶│              │                │             │
└──────────────┘                                  └──────────────┘                └─────────────┘
```

## Quick start

```bash
npm install
npm run dev          # backend (live) on :8787 + Vite on :5173 → open http://localhost:5173
```

By default the backend runs **live** — real Monad RPC (Multicall3 quotes + `getLogs` fills) + the
CEX reference feeds (Bybit + Binance). It fails fast if the chain is unreachable rather than serving fabricated data. To run
fully offline against the deterministic **simulator** (a faithful port of the design's data model,
no external dependencies):

```bash
DATA_SOURCE=sim npm run dev      # or set DATA_SOURCE=sim in .env
```

`npm run typecheck` typechecks both workspaces; `npm run build` builds the frontend.

## Workspaces

| Path        | What                                                                            |
|-------------|---------------------------------------------------------------------------------|
| `shared/`   | The contract: `QuoteRow`/`Fill`/`DailyVolume`/`MarketState` types (keyed by `venueId`), the `PAIRS`/`ASSETS`/`TOKENS` registries + verified addresses (spec App. A). |
| `server/`   | Node + TS service. `DataSource` (live / sim), the venue-adapter registry, Bybit + Binance reference feeds, aggregation, SQLite, REST/WS. |
| `web/`      | Vite + React + TS frontend. Four tabs, pixel-faithful to the design, rendering purely off the API (venues/pairs never hardcoded). |

## Backend (`server/`)

A single service owns the RPC/WS/CEX connections and serves a thin frontend (spec D1). Venues are
**composable adapters** (`server/src/venues/` — one file + one registry line per protocol; see
`ADAPTERS.md`); the core is venue-agnostic. Two `DataSource` implementations:

- **`LiveDataSource`** — quotes via each adapter's Multicall3 `eth_call` reads (POE `getQuote`,
  Metric `quoteSwap`, Clober `getExpectedOutput`) at block cadence; the pair's CEX book walked
  realized-vs-realized at size with the taker fee overlaid, converted into the pair's own terms
  (stable cross + wrap basis, spec §5.5); fills tailed from `getLogs` via each adapter's
  `decode()` and bucketed into UTC-day volume; each fill joined to its **pair's** CEX mid for
  0/5/10/30/60s markouts.
- **`SimDataSource`** — a registry-driven simulator, run only when `DATA_SOURCE=sim`
  (offline development / demos).

REST: `GET /api/markets`, `/api/quotes`, `/api/volume`, `/api/fills?days=&limit=`, `/api/health`.
WS `/stream` channels: `state`, `quotes`, `fill`, `volume`.

**What's persisted:** the SQLite DB holds the durable history — daily-volume aggregates, the
`lastProcessedBlock` cursor, **decoded fills** (expensive to re-derive: log decode + a
pair-CEX-mid markout join, so they're stored with a retention window rather than re-fetched), and
the **per-pair mid curve** (`mid_history`, so a markout-model change can replay instead of null). The
current quote matrix stays in memory (replace-on-poll, cheap). So the tape / markouts / leaderboard
are served from real history (`/api/fills?days=N`), not just a live buffer.

### Live mode is a persist-forward indexer

The public `https://rpc.monad.xyz` endpoint supports `eth_call` (quotes ✓) and short `getLogs`
ranges (live fill tailing ✓), but **caps `getLogs` to ~100 blocks**, so deep history (from the
Clober deploy block ~31.6M) can't be backfilled at the tip. Rather than depend on a deep archival
replay, live mode **indexes forward** — the SQLite DB is the source of truth for daily-volume
history:

- **Boot:** load persisted days + `lastProcessedBlock` from the DB.
- **Seed:** closed Clober Vault days are filled once from the Goldsky subgraph
  (`Σ PoolDayData.volumeUSD` over **registered** vault books). POE + Metric (no keyless
  subgraph) are seeded by a **background on-chain backfill** — each adapter's `Swap` logs
  replayed from its pool's deploy day, chunked/paced under the RPC caps, resumable across
  restarts (spec §5.4).
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

## Deploy

It ships as a **single container**: one Node process serves the REST/WS API **and** the built
frontend on the same origin (so the SPA's relative `/api` + `/stream` URLs need no config). Because
it's a stateful WS indexer (persistent CEX/Monad connections, a poll loop, SQLite), host it on a
**persistent-process** platform — not serverless/edge. Run **one replica** (single-writer SQLite +
in-memory state).

The [`Dockerfile`](Dockerfile) builds the frontend and runs the server serving it.

### Render (production — mpamm.wtf)

[`render.yaml`](render.yaml) is the blueprint: one always-on Docker web service with a
`/api/health` health check and a **persistent disk** at `/data` (`DB_PATH=/data/mpamm.db` is
baked into the image) so the SQLite history survives deploys.

- **Deploys are Render-native**: every push to `main` builds the Dockerfile and deploys
  (health-gated, zero-downtime). [`ci.yml`](.github/workflows/ci.yml) runs verification
  (typecheck server+web → build frontend → build Docker image) on every push + PR.
- Service **Variables**: `RPC_HTTP_URL` — a **trusted Monad node** (the public endpoint works
  but is rate-limited and `getLogs`-capped, which slows the on-chain backfill). Optional:
  `DATA_SOURCE=sim` (demo), `TAKER_BPS`, `BINANCE_TAKER_BPS`, `SEED_SINCE_UTC`, `SUBGRAPH_URL`,
  `BACKFILL=off`, `BACKFILL_CHUNK`, `BACKFILL_PACE_MS`.

### Any container host / local

```bash
docker build -t mpamm .
docker run --rm -p 8787:8787 -v mpamm-data:/data \
  -e RPC_HTTP_URL=https://your-monad-node \
  mpamm
# open http://localhost:8787
```
