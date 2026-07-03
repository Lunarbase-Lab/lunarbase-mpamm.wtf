# propAMM Monad Dashboard — Design Spec

| | |
|---|---|
| **Status** | Draft v0.3 — propAMM-only, composable adapters |
| **Date** | 2026-07-03 |
| **Scope** | Real-time dashboard for **propAMMs** on Monad mainnet |
| **Venues** | LFJ POE · Metric · Clober Vault (composable adapter registry) |
| **CEX benchmark** | per base asset — Bybit (MON) · Binance VIP9 (BTC/ETH), converted into each pair's terms (stable cross + wrap basis, §5.5) |
| **Reference model** | [pamm.wtf](https://pamm.wtf) (information architecture, not implementation) |

**Changelog v0.2 → v0.3** — **Venue layer refactored into a composable adapter registry** (`server/src/venues/`): one file per protocol implementing `VenueAdapter { venues(), discover(), backfill?(), quote?(), logSources(), decode() }` plus one line in `registry.ts`; the core (indexer, DB, API, frontend) is venue-agnostic and reads name/color/output from the adapter. **Scope narrowed to propAMM-only** (oracle/MM-priced venues, not passive curve DEXes or raw CLOBs): **LFJ Liquidity Book removed** (a passive bin DEX — price emerges from the curve, not a maker); **LFJ POE** (LFJ's oracle-anchored "Public Prop AMM") and **Metric** (oracle-anchored bin AMM) added. Data model generic, keyed by `venueId`; DB long-format (`daily_volume(utc_day, venue_id, …)`). Bybit reference is itself an adapter (`role: 'reference'`).

**Changelog v0.1 → v0.2** — Deployment fixed as a backend service. Historical volume derived on-chain (log replay) + a one-time Clober subgraph seed, no venue REST dependency. CEX benchmark switched **Binance → Bybit** (Binance has no MON spot). Clober attribution scoped to the **vault** (propAMM) cut. Pair universe narrowed to **MON vs USD stables**. Taker fee = configurable constant.

---

## 1. Summary

A read-only, real-time dashboard surfacing three primitives per **propAMM** venue on Monad: **historical filled volume**, **live execution quality** (realized cost vs. Bybit at a chosen notional), and a **live fill tape / markouts**. The venue set is a **plug-in registry** — each protocol ships one self-contained adapter; the rest of the system never hardcodes a venue.

**propAMM = maker/oracle-priced.** The dashboard is dedicated to venues where a market maker (or an oracle the maker anchors to) sets the price — not passive AMMs whose price emerges from a bonding curve, nor raw CLOBs. v0.3 venues: **LFJ POE**, **Metric**, and the **Clober Vault** (§3).

The defining architectural fact: **fills are events, quotes are not**. Landed trades arrive as logs you subscribe to; a live quote ("what would 50k USDC get right now") exists only by simulating against current state via an on-chain read. No subgraph or REST endpoint returns a fresh quote. That split drives the system — a streamed path for volume + tape, a polled path for execution quality.

Built and run as a **backend service** (§7.D1): the service owns the RPC/WS/Bybit connections, aggregates once, and serves a thin frontend over its own API.

---

## 2. Goals / Non-Goals

**Goals**
- Per-venue daily filled volume in USD, UTC-day buckets, today partial — advanced **on-chain** (persist-forward indexer), seeded from a subgraph where one exists.
- Per-pair live execution quality for an **HFT audience**: realized cost in bps vs. executing the same size on Bybit as taker (fee-inclusive on both legs), refreshed at block cadence — 100% like-for-like.
- A live, normalized fill tape + markouts across every venue.
- One normalized data model (`QuoteRow`, `Fill`) keyed by `venueId` so the frontend is venue-agnostic.
- A **composable venue layer**: any team adds a protocol via one adapter file + one registry line, zero core edits.

**Non-Goals (v0.3)**
- No trade execution — strictly read-only. No wallet, no order placement.
- No chains other than Monad mainnet.
- **No non-propAMM venues** — passive curve DEXes (e.g. LFJ Liquidity Book, Uniswap-style) and raw CLOBs are out of scope by design.
- Base/stable pairs only (MON, BTC, ETH vs USD stables) — the quote leg is a stable, so USD is exact with no oracle. Non-stable *quote* legs (token/token) remain out of scope.
- No deep historical analytics (per-maker league tables, PnL). Daily volume is the only persisted aggregate; fills are retained on a rolling window.

---

## 3. Background & domain model

**propAMM, maker-priced.** The organizing premise: venues where the **maker sets price** (usually anchored to an off-chain oracle), and the pool quotes around that fair value — as opposed to a passive AMM whose price is whatever the bonding curve + arbitrage make it. Each v0.3 venue qualifies for a different structural reason.

- **LFJ POE** — LFJ's "Public Prop AMM." An **oracle-anchored** pool: a per-pool ClapOracle feeds a fair price, market makers set price/ranges/fees, and depositors fund a **vault** that provides the liquidity (Concentrated-Liquidity Constant-Product / CLCP). The pool exposes an executable, fee-inclusive `getQuote`, so it prices like a maker desk, not a curve. Docs: `developers.lfj.gg/poe`.

- **Metric** — an **oracle-anchored bin AMM** (propAMM). Each pool has a per-pool `PriceProvider` feeding an off-chain oracle bid/ask; the router simulates a swap over the pool's binned liquidity around that provided price. Prices come from the oracle, not a passive curve.

- **Clober Vault** — Clober V2 is a fully on-chain CLOB; the **LiquidityVault** is an oracle-driven maker that rests orders on the book priced by `SimpleOracleStrategy`. The dashboard tracks **only the vault's flow** (the propAMM cut), not independent-maker CLOB flow.

  > `BookManager.make` has **zero oracle dependency** — the maker passes `params.tick` and that tick *is* the price; anyone can rest a limit order at any tick. `SimpleOracleStrategy` lives in the liquidity-vault package and is consumed **only by the LiquidityVault to price its own orders**; it never sits in any book's make/take path.

  So oracle-priced liquidity is a **subset** (the vault's) of the book. The dashboard isolates that subset — see attribution below.

> **Why LFJ Liquidity Book is excluded.** LB is a passive, permissionless bin DEX: LPs deposit into fixed-price bins and the pool's price is wherever the market has traded it (constant-sum per bin + arbitrage). No maker quotes it off an oracle — so it's a DEX primitive, not a propAMM. It was removed in v0.3. (LFJ's *propAMM* on Monad is POE, which we do track.)

**Clober vault attribution — verified.** `LiquidityVault.open(bookKeyA, bookKeyB, salt, strategy)` validates only that the two books are mirror images (`A.quote==B.base && A.base==B.quote`), that `base != quote`, and that neither has hooks — **no stablecoin restriction**, and native MON is supported. The vault emits `Open(key, bookIdA, bookIdB, salt, strategy)` on pool creation. Collect `bookIdA`/`bookIdB` per pool → the set of **vault book IDs**; any `Take` on a vault book ID is propAMM-cut flow. Vault maker `0xB09684…`, operator `0xCBd3C0…`, strategy `0x54cd…`.

---

## 4. Product surface — the four tabs

Borrow pamm.wtf's information architecture; build the UI custom. Every tab renders purely from the venue registry (`state.venues`) — name, color, and grouping come from `VenueMeta`, nothing hardcoded.

### 4.1 Execution (`[1]`)
Rolling window (~60s) of live quotes per pair at a chosen notional, expressed as **realized cost in bps vs. Bybit**. For each pair × side × notional:
1. **On-chain realized** — simulate the fill via the adapter's `quote()` (§5.1); `realized = quote-per-base`, venue-fee-inclusive.
2. **CEX realized** — walk the pair's CEX book (Bybit `MONUSDT` / Binance `BTCUSDT`/`ETHUSDT`, §5.5) for the **same base size**, convert into the pair's terms (wrap basis + stable cross), then overlay the **taker fee** (config constant). Realized-vs-realized at size — the only honest comparison for size-sensitive flow.
3. **vs CEX (bps)** = realized on-chain buy vs Bybit-as-taker, sign-normalized so positive = on-chain worse.

Mark `filledFull = false` when the pool/book exhausts before the full notional (surfaced as a `PARTIAL` tag). The Bybit reference chip defaults **on** so the benchmark stays visible during propAMM quote gaps.

### 4.2 Volume (`[2]`)
Stacked daily-notional-by-venue. Each landed swap contributes the USD value of its **stable quote leg**, bucketed by UTC day; today's bucket is partial and ticks up live. Because every tracked pair is **base vs a USD stable**, the quote leg *is* the stable amount → **exact USD with no price oracle**, for both history and live. A per-venue summary (all-time, share, swaps) sits beside the chart.

### 4.3 Markouts (`[3]`)
Live normalized fill tape + post-trade markouts: each fill's realized price vs the Bybit mid at T+{0s…}, aging in as it crosses each horizon. Fills whose realized price is approximated (no true execPx) are excluded from markouts rather than fabricating ~0 edge. Rows link to the tx on the explorer.

### 4.4 Leaderboard (`[4]`)
Top swaps / participants over a selectable window, filtered to fills that carry a real execPx.

---

## 5. Architecture

```
                       ┌──────────────────────── Monad RPC (trusted node) ───────────────────────────┐
                       │  eth_call · Multicall3        eth_subscribe(logs)         getLogs (history)  │
                       └──────┬──────────────────────────────┬──────────────────────────────┬────────┘
                  poll @ block cadence              live fills │                  log replay │ (history)
                       ┌──────▼───────┐                 ┌──────▼───────┐                ┌──────▼───────┐
                       │ Quote Poller │                 │ Fill Stream  │                │  Backfill    │
                       │ adapter.quote│                 │ adapter.     │                │ adapter.     │
                       │ (POE getQuote,│                │ decode() over│                │ backfill?()  │
                       │  Metric quote,│                │ logSources() │                │ (Clober      │
                       │  Clober view) │                │              │                │  subgraph)   │
                       └──────┬────────┘                └──────┬───────┘                └──────┬───────┘
                    QuoteRow[]│                          Fill[]│               historical days │
                              ▼                                ▼                               ▼
   ┌──────────────── Registry-driven Aggregation / State (venue-agnostic, keyed by venueId) ─────────┐
   │  in-mem quote matrix      │  volume bucketer (UTC-day × venueId) → DailyVolume.byVenue           │
   │  + current market state   │  + markout aging vs Bybit mid history      │  fills (SQLite + ring)  │
   └─────────────────┬───────────────────────────────────────────────────┬───────────────────────-─┘
              REST snapshots │                                      WS push │ quotes / fills / volume Δ
                       ┌─────▼────────────────────────────────────────────▼─────┐
                       │                Frontend (reads state.venues)            │
                       │        [1] Execution  [2] Volume  [3] Markouts  [4] LB  │
                       └─────────────────────────────────────────────────────────┘

   Bybit V5 WS (orderbook.50 / tickers, MONUSDT) ──► CEX book + BBO ──► exec realized-vs-realized + USD pricing
```

### 5.0 The adapter contract
`server/src/venues/adapter.ts`. Each venue is one adapter:
```ts
interface VenueAdapter {
  venues(): VenueMeta[];                                  // 1+ display venues (id, name, color, kind, role)
  discover(ctx): Promise<void>;                           // resolve pools/books; adapter holds its own state
  backfill?(ctx, sinceUtc): Promise<{ days?; fills? }>;   // optional historical seed
  quote?(ctx, sizesUsd): Promise<QuoteRow[]>;             // optional live bid/ask (Execution)
  logSources(): LogSource[];                              // { key, address, events, kind: 'fills'|'state'|'attribution' }
  decode(ctx, logs, tsOf, failed): Fill[];                // adapter decodes ITS logs → fills
}
interface ReferenceAdapter { meta(); start(); stop(); mid(); quote(sizesUsd); }   // Bybit, role:'reference'
```
`AdapterContext` hands over shared infra: `client` (viem), `getLogs` (chunked), `pricer`, `config`, `log`, `referenceMid()`. The **registry** (`registry.ts`) is the one wiring point: `ADAPTERS = [poe, cloberVault, metric]`, `REFERENCE = bybit`. `validateRegistry()` fails loud on a duplicate/invalid venue id or a non-single reference.

### 5.1 Quote poller (Execution)
Each adapter's `quote()` builds its request set and collapses it into **Multicall3 `eth_call`s** per tick, at block cadence. Normalized to `QuoteRow[]` (keyed by `venueId`), then annotated with the Bybit realized-vs-taker "vs CEX" columns.
- **LFJ POE**: `OraclePool.getQuote(swapXtoY, amountIn)` → `(amountOut, actualAmountIn, feeIn, feeOut)` — an executable, fee-inclusive view (no separate oracle read needed). `actualAmountIn < amountIn` ⇒ pool exhausted (`filledFull = false`).
- **Metric**: `PriceProvider.getBidAndAskPrice()` → `Router.quoteSwap(pool, zeroForOne, amountSpecified, priceLimitX64, bid, ask)` (Uniswap-v3-style signed deltas). Price-limit sentinels walk the full binned liquidity.
- **Clober Vault**: `BookViewer.getExpectedOutput(SpendOrderParams{ id, limitPrice = MIN_PRICE, baseAmount, … })` → `(takenQuoteAmount, spentBaseAmount)`; `spentBase < amountIn` ⇒ exhausted. Per-side sanity band; one real side ⇒ a one-sided row.

### 5.2 Fill stream (tape + live volume)
Each cycle the core `getLogs` the union of every adapter's `logSources()` over the pending range, then hands each adapter its logs to `decode()` → normalized `Fill`s (keyed by `venueId`).
- **LFJ POE `Swap`** — `Swap(sender, recipient, swapXtoY, actualAmountIn, amountOut, feeIn, feeOut)`. Input is MON iff `swapXtoY == monIsX`; stable leg = USD; realized `execPx = usd/base`.
- **Metric `Swap`** — `Swap(sender, recipient, exactInput, amount0Delta, amount1Delta, newTick, newPositionInBin)`. Signed deltas resolve side + amounts; realized `execPx`.
- **Clober `Take(bookId, tick, unit)`** — quote leg exact = `unit × unitSize`; realized base leg from the Take tick (`execPx = 1.0001^(±tick)·10^(18−stableDec)`). Counted only if `bookId ∈ vault-bookId set`.
- **Clober `RouterGateway.Swap`** — classifies Takes (category/`to`) by txHash; never a separate fill (no double-count).
- **Book cache** (`bookId → base/quote/unitSize`) from `BookManager.Open`; **vault-bookId set** from `LiquidityVault.Open` — both scanned each tail and merged (`mergeNewBooks`).

### 5.3 Aggregation / state
- **Quote matrix** — latest `QuoteRow[]` in memory, replaced each poll, pushed to clients.
- **Volume bucketer** — folds `Fill`s into `DailyVolume.byVenue[venueId] = { usd, swaps }` per UTC day; today broadcast as deltas, closed days persisted. Swap counts come from an exact SQL aggregate (no proration).
- **Markout aging** — join fills to the Bybit `mid()` history at each horizon; an `earliestMid` guard prevents fabricating elapsed-unobserved horizons.
- **Fills** — persisted to SQLite (upsert-by-id so aging markouts update in place) + an in-memory ring for cold-start.

### 5.4 Historical backfill — persist-forward indexer + optional seed
The public RPC caps `getLogs` to short ranges, so deep replay at the tip is impractical there. Live mode is a **persist-forward indexer**: SQLite is the source of truth for daily-volume history — loaded on boot, advanced forward from decoded fills (priced via the stable quote leg, exact for MON/stable), resumed from `lastProcessedBlock` with a same-day `getLogs` gap-fill.
- **Fail-closed ingest**: any error in a tail cycle — a `fills`/`state` log source, the block-timestamp lookup, or an adapter `decode()` — **holds the global cursor** and retries the exact range; nothing advances/ingests/emits partially. Fills carry a deterministic `venue-txHash-logIndex` id; daily volume + cursor + fills persist in **one transaction** (idempotent re-tail).
- **Clober** closed days are seeded once via `backfill()` from the **Goldsky subgraph** (`Σ BookDayData.volumeUSD` = venue, scoped to discovered MON/stable books; `Σ PoolDayData.volumeUSD` = the vault cut).
- **POE and Metric** (no keyless subgraph) are seeded by a **background on-chain backfill**: the core replays each adapter's `Swap` logs from its `backfillFromUtc` (set to the pool's on-chain deploy day — POE `2026-05-09`, Metric `2026-03-31`) up to the boot head, decodes via the adapter's own `decode()`, and folds into daily volume. It runs OFF the boot path (never blocks the dashboard or the tail): adaptive `getLogs` chunks (start wide, auto-shrink on a range 413) paced under the RPC cap, one `getBlock` per chunk for UTC-day bucketing (a chunk spans ~minutes), closed days only (`< today`, so no overlap with the tail), SET-per-day (idempotent). A day-aligned resume cursor + a `backfill_done_<venue>` flag make it resumable across restarts. Knobs: `BACKFILL` / `BACKFILL_CHUNK` / `BACKFILL_PACE_MS` / `BACKFILL_MERGE_EVERY`.

### 5.5 CEX references + pricing — the reference is in the PAIR'S OWN TERMS
The deep CEX books are USDT-quoted and native-asset; the on-chain pairs trade **wrapped assets in USDC**. Both mismatches are real, live-priced markets — not $1 pegs — so the reference for a pair is constructed as:

```
refPx(pair) = <BASE>USDT px × wrapBasis(base) ÷ usdtCross(quote)
```

- **`usdtCross(quote)`** — the stable's `<STABLE>USDT` mid on the SAME exchange as the base feed (Bybit `USDCUSDT` for MON pairs, Binance `USDCUSDT` for BTC/ETH). The USDC/USDT basis runs **~±10bps** — larger than most spreads shown, so a $1-peg assumption would fabricate a systematic on-chain "edge". `USDT0` needs no cross (it IS Tether's USDT on Monad); `USD1` crosses via `USD1USDT` where listed; `AUSD` (unlisted) stays peg-assumed. Registry: `TokenInfo.usdtCross`.
- **`wrapBasis(base)`** — the wrapped/native mid for wrapped assets (Binance **`WBTCBTC`**, ~−5bps live): the CEX line is shown in wrapped terms, like-for-like with the WBTC that actually trades on-chain (pamm.wtf does the same). Caveat: WBTCBTC prices Ethereum's WBTC — a proxy for Monad's bridged WBTC. WMON/canonical-WETH need none. Registry: `AssetSpec.wrapBasisSymbol`.
- **Taker walks stay on the deep USDT books**; realized walk prices are converted by the same factors at the cross MIDS (cross books are ~1bp wide, so converting at mid adds <1bp — far below the ~10bp basis it removes). An unwarm cross falls back to 1 rather than zeroing the reference.
- **Markouts are marked per PAIR** against the converted mid (`midForPair`), so MON/USDC and MON/USDT0 fills age against different, correct anchors. Validated live: the synthetic BTC reference lands within ~0.1bp of Binance's actual `BTCUSDC` book, and Metric's BTC "edge" collapsed from a fake −13bps to +0.5bps.
- `UsdPricer` (USD→token sizing, token→USD volume): stables ≈ $1 and base assets at their USDT mids — sizing tolerance, NOT used for bps anchoring.
- **Feeds**: Bybit V5 WS (`orderbook.50.MONUSDT` + tickers incl. cross symbols); Binance combined stream (`@depth20@100ms` + `@bookTicker` for BTCUSDT/ETHUSDT + crosses + WBTCBTC). REST cold-start snapshots on both; auto-reconnect re-snapshots.

---

## 6. Data model & API

### 6.1 Core types (generic, keyed by `venueId`)
```ts
VenueMeta { id; name; color{light,dark}; kind:'amm'|'clob'|'vault'|'cex'; role:'venue'|'reference'; taker? }
QuoteRow  { venueId; market; sizeUsd; bidBps; askBps; bidPx; askPx; spreadBps;
            filledFull; oneSided?; feeBps; cexAskBps?; cexBidBps?; ts }
Fill      { id; venueId; market; side; category; usd; baseAmount; execPx; pxApprox?;
            txHash; to; pool; blockNumber; ts; markoutsBps[] }
DailyVolume { utcDay; partial; byVenue: Record<venueId,{ usd; swaps }> }
```
`FillCategory = 'DIRECT'|'ROUTER'|'AGG'|'CEX/DEX'|'UNKNOWN'`. (The old `protocol`/`source`/`scope` unions and per-venue `DailyVolume` columns are **removed** — everything is keyed by `venueId`.)

### 6.2 Persisted (SQLite, long format)
```
meta(key, value)                                   -- schema_version + lastProcessedBlock cursor
daily_volume(utc_day, venue_id, usd, swaps)        -- PK (utc_day, venue_id)
day_meta(utc_day, partial)
fills(id, venue_id, …, markouts…)                  -- upsert-by-id; ~35-day retention prune
```
Adding/removing a venue never changes the table shape (just different `venue_id` values), so it is **non-destructive**: on boot `reconcileVenues()` prunes only rows whose venue left the registry, keeping every other venue's history. `schema_version` gates a full fresh-start reset **only** on a true STRUCTURAL change (columns / PK).

### 6.3 API contract (service → frontend)
```
GET  /api/venues                        the venue registry (VenueMeta[]) — UI renders from this
GET  /api/markets                       tracked markets + current state snapshot (incl. venues)
GET  /api/quotes                        latest quote matrix (incl. Bybit "vs CEX" cols)
GET  /api/volume?from=&to=              daily series (DailyVolume.byVenue)
GET  /api/fills?days=&limit=            historical fill window (markouts)
WS   /stream                            channels: state, quotes, fill, volume
```
Frontend renders purely off these — never touches the RPC, subgraph, or Bybit directly.

---

## 7. Key decisions

| # | Decision | Rationale / trade-off |
|---|---|---|
| **D1** | **Backend service**, thin frontend | One shared set of RPC/WS/Bybit connections; tip-accurate quoting needs a trusted node not exposed client-side; on-chain history needs a persistent writer. |
| **D2** | Venues = **composable adapter registry** | One file + one registry line per protocol; core is venue-agnostic. Enables community PRs and keeps the model generic (`venueId`). |
| **D3** | Scope = **propAMM-only** | Oracle/MM-priced venues only (POE, Metric, Clober Vault). Passive curve DEXes (incl. LFJ Liquidity Book) and raw CLOBs are excluded by design. |
| **D4** | History = **persist-forward indexer** + optional per-adapter `backfill()` | SQLite is the source of truth; Clober seeds from its subgraph; POE/Metric accrue forward until a backfill source is wired (D8). |
| **D5** | Clober attribution = **vault-bookId tagging** via `LiquidityVault.Open` | Only the oracle-vault (propAMM) cut counts; independent-maker CLOB flow is excluded. |
| **D6** | Universe = **base/stable pairs via a registry** | `@shared` ASSETS + PAIRS (MON/USDC, BTC/USDC, ETH/USDC) — add an asset + a pool and it lists. Quote leg = stable ⇒ exact USD. Adapters are generic over base/quote (WBTC's 8 decimals handled; `assetForToken` replaces MON-specific checks). |
| **D7** | CEX benchmark = **per-asset registry, converted into the pair's terms** | Routed by asset (`ASSETS.cex`): Bybit for MON (no Binance MON spot), Binance VIP9 for BTC/ETH. The USDT-quoted reference is converted by the live stable cross (`USDCUSDT`, ~±10bps) and the wrapped/native basis (`WBTCBTC`, ~−5bps) — never a $1 peg or a wrap≡native assumption (§5.5). Realized-vs-realized at size; taker fees are config constants (Bybit 10 bps, Binance 2.25 bps). |
| **D8** | **Deferred** | Non-stable / multi-asset market universe (e.g. POE/Metric WBTC, WETH pools) — needs historical pricing. *(Done since v0.3: POE/Metric on-chain backfill; non-destructive venue reconcile.)* |

---

## 8. Reliability & operations

- **RPC requirements**: `eth_call`, `getLogs`, `eth_subscribe`/polling. Public endpoints cap `getLogs` (~100 blocks) ⇒ persist-forward, chunked ranges. A deep backfill needs an archive/high-limit RPC.
- **Fail-closed indexing**: a failed required/state log source, block-timestamp lookup, or `decode()` holds the cursor and retries; `tick()` is re-entrancy-guarded; discovery is merge-safe (a factory read never shrinks the tailed set) and `logSources()` throws until discovered.
- **Boot**: live boot fail-fasts on a chain sanity check (chain id `143`, Multicall3 present) so a supervisor restarts it. `DATA_SOURCE=sim` is the explicit offline simulator (registry-driven, same generic contract).
- **Schema**: a venue leaving the registry is pruned non-destructively on boot (`reconcileVenues`), keeping every other venue's history. Only a true STRUCTURAL `schema_version` bump drops + rebuilds (Clober re-seeds, on-chain venues re-backfill).
- **Deploy**: Render native GitHub auto-deploy from `main` (health-gated, zero-downtime); persistent disk holds the SQLite DB.

---

## Appendix A — Verified contracts (Monad mainnet)

**LFJ POE** (Public Prop AMM — `developers.lfj.gg/poe`)
| Contract | Address |
|---|---|
| OraclePoolFactory | `0x78120F2C0EBF0cc8B7E7749e62D36e6523dD711D` |
| Router | `0x5a2D87017465C7e91AdB87bc2181394C612Fa1bd` |
| ClapOracle | `0x33176bE288E54c440941d407dF33456A23eDE078` |
| OraclePool (impl) | `0xc83a1F88b4a9a71806C52fa00669f2735a9d359b` |
| WMON/USDC pool (tracked) | `0x02A8A16613a421EabaD6861fF6d8159f6D5EDB8f` |
| AUSD/USDC pool (out of scope — stable/stable) | `0x06C526964bFB06c6BAAC17fF91a36EC671382171` |

**Metric** (oracle-anchored bin AMM)
| Contract | Address |
|---|---|
| Router (`MetricOmmSwapRouter`) | `0xaF9ADa6b6eC7993CE146f6c0bF98f7211CDfD3e5` |
| WMON/USDC pool (tracked) | `0xFA32f9ec28787d1F9C5BA5c39e54e59984FEF3f0` |
| PriceProvider | per-pool (resolved via `getImmutables`) |

**Clober V2**
| Contract | Address |
|---|---|
| BookManager (core; deploy block 31662843) | `0x6657d192273731C3cAc646cc82D5F28D0CBE8CCC` |
| BookViewer | `0xe424c211e2Ed8a5B6d1C57FA493C41715568D238` |
| Controller | `0x19b68a2b909D96c05B623050C276FBD457De8e83` |
| RouterGateway | `0x7B58A24C5628881a141D630f101Db433D419B372` |
| LiquidityVault (propAMM maker) | `0xB09684f5486d1af80699BbC27f14dd5A905da873` |
| SimpleOracleStrategy | `0x54cd5332b1689b6506Ce089DA5651B1A814e9E7D` |
| Operator | `0xCBd3C0B81A9a36356a3669A7f60A0d2F0846195B` |

**Tokens / infra**
| Token | Address |
|---|---|
| USDC | `0x754704bc059f8c67012fed69bc8a327a5aafb603` |
| USDT0 | `0xe7cd86e13ac4309349f30b3435a9d337750fc82d` |
| AUSD | `0x00000000efe302beaa2b3e6e1b18d08d69a9012a` |
| USD1 | `0x111111d2bf19e43c34263401e0cad979ed1cdb61` |
| WMON | `0x3bd359c1119da7da1d913d1c4d2b7c461115433a` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

## Appendix B — Data sources

**Primary: on-chain** (RPC `eth_call` / logs). Live quotes, live fills, and forward volume all derive from chain state + logs.

**Seed / cross-check:**
- **Clober subgraph** (Goldsky, public): `https://api.goldsky.com/api/public/project_clsljw95chutg01w45cio46j0/subgraphs/v2-subgraph-monad/latest/gn`. Entities incl. `BookDayData`, `PoolDayData`, `Take`, `Pool`, `Book`. Used by `backfill()` for closed-day volume.
- POE/Metric: no keyless historical source wired yet (§5.4, D8).

## Appendix C — Event signatures & quote interfaces (verified on-chain)

**LFJ POE** (OraclePool)
```solidity
function getPool(address tokenX, address tokenY) view returns (address);           // OraclePoolFactory
function getTokens() view returns (address tokenX, address tokenY);
function getQuote(bool swapXtoY, uint256 amountIn)
  view returns (uint256 amountOut, uint256 actualAmountIn, uint256 feeIn, uint256 feeOut);
event Swap(address indexed sender, address indexed recipient, bool indexed swapXtoY,
  uint256 actualAmountIn, uint256 amountOut, uint256 feeIn, uint256 feeOut);
// price read (unused by the adapter — getQuote is executable): getCurrentPrice(bytes32,uint,uint) → (bidE24, askE24)
```

**Metric** (oracle-anchored bin AMM)
```solidity
function getImmutables() view returns (address factory, address priceProvider, address token0, address token1, …);
function getBidAndAskPrice() view returns (uint128 bidX64, uint128 askX64);         // PriceProvider
function quoteSwap(address pool, bool zeroForOne, int128 amountSpecified,
  uint128 priceLimitX64, uint128 bidPriceX64, uint128 askPriceX64)
  returns (int128 amount0Delta, int128 amount1Delta);                              // Router
event Swap(address sender, address recipient, bool exactInput,
  int128 amount0Delta, int128 amount1Delta, int16 newTick, uint104 newPositionInBin);
```

**Clober** — `BookId = uint192`, `Tick = int24`
```solidity
function getExpectedOutput(SpendOrderParams params) view returns (uint256 takenQuoteAmount, uint256 spentBaseAmount);
//   SpendOrderParams = (uint192 id, uint256 limitPrice, uint256 baseAmount, uint256 minQuoteAmount, bytes hookData)
event Take(uint192 indexed bookId, address indexed user, int24 tick, uint64 unit);      // quote leg exact = unit*unitSize
event Open(uint192 indexed id, address indexed base, address indexed quote,
  uint64 unitSize, uint24 makerPolicy, uint24 takerPolicy, address hooks);              // BookManager
event Swap(address indexed user, address indexed inToken, address indexed outToken,
  uint256 amountIn, uint256 amountOut, address router, bytes4 method);                  // RouterGateway
event Open(bytes32 indexed key, uint192 indexed bookIdA, uint192 indexed bookIdB,
  bytes32 salt, address strategy);                                                      // LiquidityVault (vault-cut tagging)
```

## Appendix D — Bybit V5 (CEX benchmark)

**Symbol** `MONUSDT` (spot). WS `wss://stream.bybit.com/v5/public/spot` — `orderbook.50.MONUSDT` (snapshot+delta) + `tickers.MONUSDT` (BBO); REST `GET /v5/market/orderbook` + `/v5/market/instruments-info`. Mid = `(bestBid + bestAsk)/2`.

**Spot taker fee** defaults to non-VIP **10 bps**; set the exec view's taker constant to the operator's actual rate (VIP/PRO tiers and the MNT discount lower it).
