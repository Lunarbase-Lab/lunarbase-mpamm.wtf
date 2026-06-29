# propAMM Monad Dashboard — Design Spec

| | |
|---|---|
| **Status** | Draft v0.2 — open questions closed |
| **Date** | 2026-06-29 |
| **Scope** | Real-time dashboard for prop AMMs on Monad mainnet |
| **Venues (v1)** | LFJ Liquidity Book v2.2 · Clober V2 |
| **CEX benchmark** | Bybit spot (`MONUSDT`) |
| **Reference model** | [pamm.wtf](https://pamm.wtf) (information architecture, not implementation) |

**Changelog v0.1 → v0.2** — Deployment fixed as a backend service. LFJ live quote = `LBPair.getSwapOut` only (standalone Quoter dropped). Historical volume derived **purely on-chain** (log replay), no venue REST dependency. CEX benchmark switched **Binance → Bybit** (Binance has no MON spot). Clober vault attribution verified: vault pools can be **non-stable**, tagged live via `LiquidityVault.Open`. Pair universe narrowed to **MON vs USD stables**. Taker fee = configurable constant.

---

## 1. Summary

A read-only, real-time dashboard surfacing three primitives per prop-AMM venue on Monad: **historical filled volume**, **live execution quality** (realized cost vs. Bybit at a chosen notional), and a **live fill tape**. v1 covers LFJ Liquidity Book v2.2 (bin AMM) and Clober V2 (fully on-chain CLOB); the venue layer is an interface so a third venue is additive.

The defining architectural fact: **fills are events, quotes are not**. Landed trades arrive as logs you subscribe to; a live quote ("what would 50k USDC get right now") exists only by simulating against current state via an on-chain read. No subgraph or REST endpoint returns a fresh quote. That split drives the system — a streamed path for volume + tape, a polled path for execution quality.

Built and run as a **backend service** (§7.D1): the service owns the RPC/WS/Bybit connections, aggregates once, and serves a thin frontend over its own API.

---

## 2. Goals / Non-Goals

**Goals**
- Per-venue daily filled volume in USD, UTC-day buckets, today partial — backfilled and advanced **entirely on-chain**.
- Per-pair live execution quality for an **HFT audience**: realized cost in bps vs. executing the same size on Bybit as taker (fee-inclusive on both legs), refreshed at block cadence — 100% like-for-like.
- A live, normalized fill tape across both venues.
- One normalized data model (`Quote`, `Fill`) so the frontend is venue-agnostic.
- Correct propAMM attribution on Clober: distinguish the oracle-vault (propAMM) cut from total venue flow.

**Non-Goals (v1)**
- No trade execution — strictly read-only. No wallet, no order placement.
- No chains other than Monad mainnet.
- No venues beyond LFJ LB v2.2 and Clober V2 (but the abstraction must not preclude them).
- No pairs beyond **MON vs USD stables** in v1 (§5; non-stable pairs need historical pricing, deferred).
- No deep historical analytics (per-maker league tables, PnL). Daily volume is the only persisted history.
- No on-chain depth chart in v1 (top-of-book mid + realized cost only; full depth is a fast-follow).

---

## 3. Background & domain model

**propAMM, maker-priced.** The organizing premise: venues where the **maker** sets price, not the protocol. Both v1 venues qualify, for different structural reasons.

- **LFJ Liquidity Book** — bin-based concentrated liquidity. Each bin is a fixed price; LPs choose which bins to fund. Quoting walks bins from the active bin outward; the dynamic fee is folded into `getSwapOut`.

- **Clober V2** — fully on-chain CLOB. Verified, and load-bearing for attribution:

  > `BookManager.make` has **zero oracle dependency**. The maker passes `params.tick`, and that tick *is* the price. `onlyByLocker` is the V4-style lock; the only maker gate is a fee-routing whitelist on `provider` (may be zero). Anyone can rest a limit order at any tick.
  >
  > `SimpleOracleStrategy` lives in the liquidity-vault package, implements `IStrategy.computeOrders(key)`, and is consumed **only by the LiquidityVault to price its own orders**. It is not a hook and never sits in any book's make/take path.

  So oracle-priced liquidity is a **subset** (the vault's) of the book, not a venue property. Two makers coexist: the **LiquidityVault** as an oracle-driven maker, and **independent makers** at self-chosen ticks. Both satisfy the maker-priced criterion.

**Vault attribution — verified (§9 closed).** `LiquidityVault.open(bookKeyA, bookKeyB, salt, strategy)` validates only that the two books are mirror images (`A.quote==B.base && A.base==B.quote`), that `base != quote`, and that neither has hooks. **There is no stablecoin restriction** — a vault pool can be any pair, including non-stable/non-stable, and the vault even handles native MON. Consequence: vault (propAMM) volume must be USD-priced the same way as venue volume, not assumed to have a stable leg (moot for the v1 MON/stable pairs, but true in general).

The live tagging mechanism is fully on-chain: the vault emits
```solidity
event Open(bytes32 indexed key, BookId indexed bookIdA, BookId indexed bookIdB, bytes32 salt, address strategy);
```
on pool creation (vault `0xb09684…`). Collect `bookIdA`/`bookIdB` per pool → the set of **vault book IDs**. Any `Take` on a vault book ID is propAMM-cut flow; everything else is independent-maker flow. The dashboard surfaces this as a labeled toggle:
- **Whole-venue** → all `Take` flow (`BookDayData.volumeUSD` as subgraph cross-check).
- **Vault (propAMM) cut** → `Take` on vault book IDs (`PoolDayData.volumeUSD` as cross-check).

Vault maker `0xb09684…`, operator `0xcbd3c0…`, strategy `0x54cd…` — all confirmed against the canonical subgraph config and the liquidity-vault deployments table.

---

## 4. Product surface — the three views

Borrow pamm.wtf's information architecture; build the UI custom (own identity, via the `frontend-design` guidance). Each view maps onto one data pipeline.

### 4.1 Volume (`/volume`)
Stacked daily-notional-by-venue. Each landed swap contributes the USD value of its **stable quote leg**, bucketed by UTC day; today's bucket is partial and ticks up live. Because v1 targets **MON vs stables**, the quote leg *is* the stable amount → **exact USD with no price oracle**, for both history and live.
- **History** + **live tail** both from on-chain log replay (§5.4) — same decoders, `getLogs` vs `eth_subscribe`.
- Toggle: Clober *whole-venue* vs *vault-only* (§3).

### 4.2 Exec (`/exec`) — HFT-grade, 100% like-for-like
Rolling window (~60s) of live quotes per pair at a chosen notional, expressed as **realized cost in bps vs. Bybit**.

For each pair × side × notional:
1. **On-chain realized** — simulate the fill (§5.1); `realized = quote-per-base`, venue-fee-inclusive (LFJ `getSwapOut` and Clober `getExpectedOutput` both already net fees).
2. **Bybit realized** — walk the live Bybit `MONUSDT` book (§5.5) for the **same base size**, then overlay the **taker fee** (config constant, §7.D7). This is realized-vs-realized at size, not mid-vs-mid — the only honest comparison for size-sensitive HFT flow.
3. **Spread (bps)** = how much worse/better the on-chain venue executes vs. Bybit-as-taker, sign-normalized so positive = on-chain is worse.

A secondary `vs mid` column uses the Bybit BBO mid (`(bestBid+bestAsk)/2`) for a fee-agnostic reference. Mark `filledFull = false` when bins/book exhaust before the full notional.

### 4.3 Trade tape
Live normalized fills across both venues — venue, pair, side, USD size, tx. The tape and the live volume tail consume the same `Fill` stream two ways.

---

## 5. Architecture

```
                       ┌──────────────────────── Monad RPC (trusted node) ───────────────────────────┐
                       │  eth_call · Multicall3        eth_subscribe(logs)         getLogs (history)  │
                       └──────┬──────────────────────────────┬──────────────────────────────┬────────┘
                  poll @ block cadence              live fills │                  log replay │ (history)
                       ┌──────▼───────┐                 ┌──────▼───────┐                ┌──────▼───────┐
                       │ Quote Poller │                 │ Fill Stream  │                │  Backfill    │
                       │ LFJ getSwapOut│                │ LFJ Swap     │                │ getLogs +    │
                       │ Clober        │                │ Clober Take  │                │ SAME         │
                       │ getExpectedOut│                │ Router Swap  │                │ decoders     │
                       └──────┬────────┘                └──────┬───────┘                └──────┬───────┘
                        Quote[]│                          Fill[]│               historical Fill[]│
                               ▼                                ▼                               ▼
   ┌───────────────────────────────────── Aggregation / State ─────────────────────────────────────┐
   │  in-mem quote matrix      │  volume bucketer (UTC-day, venue + vault scope) → DailyVolume       │
   │  + current market state   │  + vault-bookId set (from LiquidityVault.Open)   │  fills ring      │
   └─────────────────┬───────────────────────────────────────────────────┬───────────────────────-─┘
              REST snapshots │                                      WS push │ quotes / fills / volume Δ
                       ┌─────▼────────────────────────────────────────────▼─────┐
                       │                       Frontend                          │
                       │            /volume        /exec        tape             │
                       └─────────────────────────────────────────────────────────┘

   Bybit V5 WS (orderbook.50 / tickers, MONUSDT) ──► CEX book + BBO ──► exec realized-vs-realized + USD pricing
```

### 5.1 Quote poller (exec view)
Build a flat request set across pairs × sides × notionals and collapse it into a **single `eth_call` via Multicall3** per tick, at block cadence. Normalize to `Quote[]`.
- **LFJ**: `LBPair.getSwapOut(amountIn, swapForY)` → `(amountInLeft, amountOut, fee)`, fee-inclusive. **This is the only LFJ quote path** — the standalone Quoter is not used, and `router-api.lfj.dev` is Avalanche-only.
- **Clober**: `BookViewer.getExpectedOutput(SpendOrderParams{ id, limitPrice = MIN_PRICE, baseAmount, minQuoteAmount = 0, hookData = 0x })` → `(takenQuoteAmount, spentBaseAmount)`. `MIN_PRICE` walks the book with no early stop; `spentBase < amountIn` ⇒ exhausted.
- A Clober market is a **pair of one-directional books**; quoting targets the book whose `base` == input token.

### 5.2 Fill stream (tape + live volume)
WebSocket `eth_subscribe(logs)` → one normalized `Fill`:
- **LFJ `Swap`** — amounts are two `uint128` packed in one `bytes32` (`low128 = X`, `high128 = Y`); mask/shift, **no byte reversal** in JS. Input leg is whichever side is non-zero.
- **Clober `Take(bookId, tick, unit)`** — **quote leg is exact**: `unit × unitSize`; no tick math for USD volume. (Base leg needs `unitToBase(unitSize, unit, priceFromTick)`, deferred — affects only the base amount in the tape, not volume.) Tag scope = vault if `bookId ∈ vault-bookId set`, else venue.
- **Clober `RouterGateway.Swap`** — clean netted `(inToken, outToken, amountIn, amountOut, router, method)` for routed flow.
- **Book cache** (`bookId → base/quote/unitSize`) from BookManager `Open` (backfill via `getLogs` from block `31662843`, kept fresh by subscription).
- **Vault-bookId set** from `LiquidityVault.Open` (backfill + subscription).

### 5.3 Aggregation / state
- **Quote matrix** — latest `Quote[]` in memory, replaced each poll, pushed to clients.
- **Volume bucketer** — folds `Fill`s into `Map<venue, Map<scope, Map<utcDay, usd>>>` (`scope ∈ {venue, vault}`); today broadcast as deltas, closed days persisted.
- **Fills ring buffer** — last N fills for tape cold-start.
- **Market state** — per-pair reserves/active-bin (LFJ), best bid/ask (Clober); slower cadence than the quote poll.

### 5.4 Historical backfill — purely on-chain
On cold start (and to fill gaps), **replay logs** with the same decoders as the live stream: LFJ `Swap` and Clober `Take`, priced via the stable quote leg (exact for MON/stable pairs). No venue REST or subgraph dependency. The Clober subgraph (`bookDayDatas`/`poolDayDatas`) and the LFJ analytics API remain available as optional cross-checks/accelerators, not as sources of truth.
- Chunk `getLogs` block ranges if the provider caps them.
- Historical USD for non-stable pairs would need a historical price feed → out of v1 scope (consistent with the MON/stable focus).

### 5.5 Bybit benchmark + pricing
A single `UsdPricer` shared by the poller (USD→token notional sizing) and the stream (token→USD volume).
- Stables (USDC, USDT0, AUSD, USD1) pegged to $1.
- MON USD price from the **Bybit `MONUSDT`** feed (also the exec benchmark); self-bootstraps from each venue's stable-quoted mid as a fallback.
- **Bybit V5 market data** (servers in Singapore; public WS not rate-limited):
  - WS `wss://stream.bybit.com/v5/public/spot`; subscribe `{"op":"subscribe","args":["orderbook.50.MONUSDT","tickers.MONUSDT"]}`. `orderbook.{1,50,200,1000}` (depth-50 pushes ~20ms) maintained snapshot+delta (reset local book on each new snapshot); `tickers.MONUSDT` (~50ms) for BBO.
  - REST `GET /v5/market/orderbook?category=spot&symbol=MONUSDT&limit=50` for cold-start snapshot; `GET /v5/market/instruments-info?category=spot&symbol=MONUSDT` for tick/lot size.
  - Exec walks the maintained book for the requested base size → Bybit realized price; overlay the taker fee constant.

---

## 6. Data model & API

### 6.1 Core types (scaffolded)
```ts
Quote {
  protocol; market; side;          // 'buy'|'sell' of base
  notionalUsd; inToken; outToken; amountIn; amountOut;
  feeRaw?;                          // LFJ only
  realizedPrice; midPrice; spreadBps; filledFull; ts;
  // exec adds: cexRealizedPrice; cexSpreadBps (Bybit, fee-inclusive)
}

Fill {
  protocol; source;                 // 'lfj-swap'|'clober-take'|'clober-router'
  market?; txHash; logIndex; blockNumber; trader;
  inToken; inAmount; outToken; outAmount; feeRaw?;
  notionalUsd?; ts?;
  // clober adds: scope ∈ {venue, vault}
}
```

### 6.2 Persisted
```
DailyVolume(protocol, utcDay, scope, volumeUsd)   scope ∈ {venue, vault}
```
v1 storage = SQLite (single-writer service, low cardinality). Promote to Postgres/Timescale only if per-pair or intraday series land. Live state stays in memory.

### 6.3 API contract (service → frontend)
```
GET  /api/markets                       tracked markets + current state snapshot
GET  /api/quotes                        latest quote matrix snapshot (incl. Bybit cols)
GET  /api/volume?from=&to=&scope=        daily series per venue/scope
WS   /stream                            channels: quotes (full matrix/poll),
                                         fills (per fill), volume (today delta/venue/scope)
```
Frontend renders purely off these — never touches the RPC, subgraph, or Bybit directly.

---

## 7. Key decisions (open questions closed)

| # | Decision | Rationale / trade-off |
|---|---|---|
| **D1** | **Backend service**, thin frontend | One shared set of RPC/WS/Bybit connections vs. every browser hammering an RPC each block; tip-accurate quoting needs a trusted node not exposed client-side; on-chain history needs a persistent writer. Cost: a service to run. |
| **D2** | LFJ live quote = **`LBPair.getSwapOut`** only | Standalone Quoter dropped (the published one is tagged "LFJ v1"; routing unverified and unnecessary). Per-pair `getSwapOut` is canonical and fee-inclusive. |
| **D3** | History = **on-chain log replay** | No `api.lfj.dev`/subgraph dependency. Same decoders as the live stream; exact USD via the stable quote leg for MON/stable pairs. Cost: non-stable history needs a price feed (out of v1 scope). |
| **D4** | Clober attribution = **vault-bookId tagging** via `LiquidityVault.Open` | Vault pools verified non-stable-capable, so USD-price like venue flow; toggle vault vs whole-venue. Contracts are primary source, subgraph is cross-check. |
| **D5** | Pair universe = **MON vs USD stables** | v1 target. Track WMON (and native MON where a venue uses it) vs USDC/USDT0, whichever each venue lists. Discovery filters Open logs / factory pairs to `{WMON, MON-native, USDC, USDT0}`. |
| **D6** | CEX benchmark = **Bybit spot `MONUSDT`** | Binance has no MON spot; Bybit carries the largest MON spot volume. V5 WS book + BBO (§5.5). |
| **D7** | Taker fee = **config constant (bps)** | HFT accuracy ⇒ set to *your* Bybit tier, not a universal. Default = non-VIP taker 0.10% (10 bps); VIP/PRO tiers and the MNT fee-discount lower it (Appendix D). Realized-vs-realized at size, fee on the CEX leg. |

---

## 8. Reliability & operations

- **RPC requirements**: node must support `eth_call` (state/block context for tip accuracy), `getLogs`, `eth_subscribe`. Public endpoints generally won't — assume a trusted node.
- **`getLogs` range caps**: chunk the `Open`/history backfill (from block `31662843`) if the provider caps ranges.
- **WS resilience (both Monad + Bybit)**: auto-reconnect with backoff; on Monad reconnect, replay missed fills via `getLogs` from the last seen block so volume buckets don't gain a gap; on Bybit reconnect, re-snapshot the book.
- **Quote poll failures**: `allowFailure` per multicall entry so one bad market doesn't blank the matrix; surface stale-quote age in the UI.
- **Sanity checks**: chain id (`143`), Multicall3 at the canonical address, native-MON-vs-WMON usage per venue/book (LFJ pairs are ERC20 ⇒ WMON; Clober supports native MON via `isNative()`).
- **Backpressure**: tape/volume are append-only; the quote matrix is replace-on-poll, so a slow client drops to the latest snapshot.

---

## 9. Remaining verifications

Down to runtime/operational checks — no design forks left.
1. **Exact Bybit VIP/PRO per-tier numbers** — confirm against the logged-in fee page; only sets the default (each trader overrides D7 with their own rate).
2. **Multicall3 deployment** at the canonical address on Monad mainnet.
3. **Specific MON-pair addresses / book IDs** — resolved by discovery at startup (not hardcoded): LFJ via factory pairs filtered to the token set; Clober via `Open` logs filtered to the token set.
4. **Native MON vs WMON** per venue/book — confirm at discovery (affects symbol mapping for the Bybit leg and decimals).

---

## 10. Milestones

- **M0 — Data layer (done).** Multicall quote poller + WS fill stream + normalized types + discovery + live volume bucketer. Runnable scaffold delivered; pending local `npm install && typecheck` and a trusted RPC.
- **M1 — Service.** Aggregation/state + REST/WS API + SQLite history + on-chain backfill + vault-bookId tagging + Bybit feed + reconnect/replay resilience.
- **M2 — Frontend.** The three views against the API (pull `frontend-design`): stacked volume chart (venue/vault toggle), exec table with the Bybit realized-vs-realized column, live tape.
- **M3 — Polish.** Depth chart, Clober tick→price base leg, non-stable pair pricing, third-venue interface validation.

---

## Appendix A — Verified contracts (Monad mainnet)

**LFJ Liquidity Book v2.2**
| Contract | Address |
|---|---|
| LBFactory | `0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c` |
| LBRouter | `0x18556DA13313f3532c54711497A8FedAC273220E` |
| LBPair | deployed per-pair by the factory |

(Standalone Quoter intentionally unused — D2.)

**Clober V2**
| Contract | Address |
|---|---|
| BookManager (core; deploy block 31662843) | `0x6657d192273731C3cAc646cc82D5F28D0CBE8CCC` |
| BookViewer | `0xe424c211e2Ed8a5B6d1C57FA493C41715568D238` |
| Controller | `0x19b68a2b909D96c05B623050C276FBD457De8e83` |
| RouterGateway | `0x7B58A24C5628881a141D630f101Db433D419B372` |
| LiquidityVault (Rebalancer, propAMM maker) | `0xB09684f5486d1af80699BbC27f14dd5A905da873` |
| SimpleOracleStrategy | `0x54cd5332b1689b6506Ce089DA5651B1A814e9E7D` |
| Operator | `0xCBd3C0B81A9a36356a3669A7f60A0d2F0846195B` |
| Wrapped6909Factory | `0x9050b0A12D92b8ba7369ecc87BcD04643Fa0CfDB` |

**Tokens / infra**
| Token | Address |
|---|---|
| USDC | `0x754704bc059f8c67012fed69bc8a327a5aafb603` |
| USDT0 | `0xe7cd86e13ac4309349f30b3435a9d337750fc82d` |
| AUSD | `0x00000000efe302beaa2b3e6e1b18d08d69a9012a` |
| USD1 | `0x111111d2bf19e43c34263401e0cad979ed1cdb61` |
| WMON | `0x3bd359c1119da7da1d913d1c4d2b7c461115433a` |
| Multicall3 (verify deployed) | `0xcA11bde05977b3631167028862bE2a173976CA11` |

## Appendix B — Data sources

**Primary: on-chain** (RPC `eth_call` / `eth_subscribe` / `getLogs`). Live quotes, live fills, and historical volume all derive from chain state + logs (D3).

**Optional cross-checks (not dependencies):**
- LFJ analytics: `GET https://api.lfj.dev/v1/dex/analytics/monad?version=v2.2` (header `x-lfj-api-key`).
- Clober subgraph (Goldsky, public): `https://api.goldsky.com/api/public/project_clsljw95chutg01w45cio46j0/subgraphs/v2-subgraph-monad/latest/gn` (fallback Ormi: `…/27ad58eb-…/subgraphs/v2-subgraph-monad/latest/gn`). Entities incl. `BookDayData`, `PoolDayData`, `Take`, `Pool`, `Book`.

## Appendix C — Event signatures & quote interfaces (verified against source)

**LFJ** — `BookId/Tick` n/a
```solidity
function getSwapOut(uint128 amountIn, bool swapForY)
  view returns (uint128 amountInLeft, uint128 amountOut, uint128 fee);
// also: getSwapIn, getActiveId, getReserves, getTokenX/Y, getBinStep, getPriceFromId

event Swap(address indexed sender, address indexed to, uint24 id,
  bytes32 amountsIn, bytes32 amountsOut, uint24 volatilityAccumulator,
  bytes32 totalFees, bytes32 protocolFees);
// amounts/fees: two uint128 packed in one bytes32 — low128 = X, high128 = Y; no reversal in JS

// LBFactory: getNumberOfLBPairs(), getLBPairAtIndex(uint256),
//   event LBPairCreated(address indexed tokenX, address indexed tokenY, uint256 indexed binStep, address LBPair, uint256 pid)
```

**Clober** — `BookId = uint192`, `Tick = int24`, `MAX_TICK = 524287`
```solidity
// BookViewer
function getExpectedOutput(SpendOrderParams params)   // spend base -> take quote
  view returns (uint256 takenQuoteAmount, uint256 spentBaseAmount);
//   SpendOrderParams = (uint192 id, uint256 limitPrice, uint256 baseAmount, uint256 minQuoteAmount, bytes hookData)
function getExpectedInput(TakeOrderParams params)
  view returns (uint256 takenQuoteAmount, uint256 spentBaseAmount);
//   TakeOrderParams  = (uint192 id, uint256 limitPrice, uint256 quoteAmount, uint256 maxBaseAmount, bytes hookData)
function getLiquidity(BookId id, Tick from, uint256 n)
  view returns (Liquidity[] /* { Tick tick; uint64 depth } */);
// walk-whole-book sentinels: MIN_PRICE = 1350587,
//   MAX_PRICE = 4647684107270898330752324302845848816923571339324334

// BookManager
event Take(uint192 indexed bookId, address indexed user, int24 tick, uint64 unit);
//   quote leg is EXACT = unit * unitSize (no tick math for USD volume)
event Open(uint192 indexed id, address indexed base, address indexed quote,
  uint64 unitSize, uint24 makerPolicy, uint24 takerPolicy, address hooks);
event Make(uint192 indexed bookId, address indexed user, int24 tick,
  uint256 orderIndex, uint64 unit, address provider);

// RouterGateway
event Swap(address indexed user, address indexed inToken, address indexed outToken,
  uint256 amountIn, uint256 amountOut, address router, bytes4 method);

// LiquidityVault — propAMM-cut tagging: collect bookIdA/bookIdB per pool
event Open(bytes32 indexed key, BookId indexed bookIdA, BookId indexed bookIdB,
  bytes32 salt, address strategy);
//   open(bookKeyA, bookKeyB, salt, strategy) validates: A.quote==B.base && A.base==B.quote,
//   base != quote, no hooks. NO stablecoin restriction; native MON supported.
```

## Appendix D — Bybit V5 (CEX benchmark)

**Symbol** `MONUSDT` (spot, Main Trading Zone, listed 2025-11-24).

**Market data**
- WS `wss://stream.bybit.com/v5/public/spot` — `orderbook.{1,50,200,1000}.MONUSDT` (snapshot+delta; depth-50 ~20ms), `tickers.MONUSDT` (~50ms, BBO). Public WS is not rate-limited.
- REST `GET /v5/market/orderbook?category=spot&symbol=MONUSDT&limit=[1..200]`; `GET /v5/market/instruments-info?category=spot&symbol=MONUSDT` (tick/lot size). Mid = `(bestBid + bestAsk)/2`.

**Spot fee schedule** (crypto-crypto; confirm exact tiers when logged in — D7/§9.1)
| Tier | Taker | Maker |
|---|---|---|
| Non-VIP (default) | 0.100% | 0.100% |
| VIP 1 (representative) | ~0.080% | ~0.060% |
| Top retail VIP (representative) | ~0.030% | ~0.010% |
| PRO / market-maker | lower; maker rebates possible | — |

Paying fees with MNT applies an additional discount. The exec view's taker constant defaults to non-VIP 10 bps and should be set to the operator's actual taker rate.