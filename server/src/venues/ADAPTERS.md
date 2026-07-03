# Writing a venue adapter

The dashboard is **venue-agnostic**. Every venue — an on-chain AMM, a CLOB, a
market-making vault — is a self-contained *adapter*. The indexer, database, API
and frontend never mention a venue by name: they read everything (display name,
color, per-day volume, fills, quotes) from your adapter. **Adding a venue is one
new file + one line in `registry.ts`. No core edits.**

Your data can be **fully on-chain**, from a **subgraph**, or a **mix** — the
contract is only about the *shapes you return*, not where you get them.

The shipped adapters are the reference implementations:
- **`poe.ts`** / **`metric.ts`** — fully on-chain (discover pools via a factory/immutables read, quote via a view call, decode Swap logs), seeded by the core's background on-chain backfill (`backfillFromUtc`).
- **`clober.ts`** — mixed: subgraph for discovery + closed-day `backfill()`, chain for live quotes + fills (with router attribution + mid-run book discovery).

## Quick start
1. `cp _template.ts myvenue.ts` and fill in the TODOs.
2. Register it in `registry.ts`:
   ```ts
   import { createMyVenueAdapter } from './myvenue.js';
   export const ADAPTERS: VenueAdapter[] = [ createPoeAdapter(), createCloberVaultAdapter(), createMetricAdapter(), createMyVenueAdapter() ];
   ```
3. `npm -w server run typecheck`, then run it (`npm run dev`) and open the dashboard.

## The interface (`adapter.ts`)
```ts
interface VenueAdapter {
  venues(): VenueMeta[];                                   // your display venue(s)
  discover(ctx): Promise<void>;                            // find markets/pools; hold your own state
  backfill?(ctx, sinceUtc): Promise<AdapterBackfill>;      // OPTIONAL closed-day seed
  quote?(ctx, sizesUsd): Promise<QuoteRow[]>;              // OPTIONAL live bid/ask (Execution tab)
  logSources(): LogSource[];                               // contracts/events the core getLogs's for you
  decode(ctx, logs, tsOf): Fill[] | Promise<Fill[]>;       // your logs → normalized fills
}
```
Everything you need is on `ctx` (`AdapterContext`) — **use it instead of importing globals**:
`ctx.client` (viem), `ctx.getLogs`, `ctx.pricer` (`usdPerToken`/`tokenForUsd` for USD notional sizing; **`pairMid(market)`** = the pair's CEX reference mid in the pair's own terms — wrap basis + stable cross applied — use it as the bps anchor when quoting), `ctx.config`, `ctx.log`.

**Only quote/emit REGISTERED pairs** (`@shared` `PAIRS`; check a combo with `pairFor(baseKey, stableSym)`). An unregistered market has no reference rows and no markout routing — the core drops it.

## What to return
- **`VenueMeta`** — `{ id, name, color: { light, dark }, kind: 'amm'|'clob'|'vault'|'cex', role: 'venue' }`. `id` is the stable key used as `Fill.venueId` / `QuoteRow.venueId`. `color` is the single source of truth the UI uses for lines/bars/swatches.
- **`Fill`** — `{ id, venueId, market, side, category, usd, baseAmount, execPx, txHash, to, pool, blockNumber, ts, markoutsBps: [null,null,null,null,null] }`. Give `id` a **deterministic** value (`` `${venue}-${txHash}-${logIndex}` ``) so a re-tail/gap-fill/restart dedupes instead of double-counting. Leave `markoutsBps` null — the core ages them vs the reference. Set `pxApprox: true` if `execPx` isn't a real realized price (it'll be excluded from markout stats).
- **`QuoteRow`** — `{ venueId, market, sizeUsd, bidBps, askBps, bidPx, askPx, spreadBps, filledFull, feeBps, ts }`. bid/ask in **bps vs the reference mid**; px is **quote-per-base** (stable per base asset). Set `oneSided: true` when only one side is executable at that size.
- **`backfill()`** → `{ days?: [{ utcDay, byVenue: { [id]: { usd, swaps? } } }], fills? }`. Volume-only closed days are fine (`swaps` defaults to 0).

## How the core uses you
- **Boot:** `discover()` once; then `backfill()` (if present) seeds closed days.
- **Each tick:** the core fetches every `logSources()` entry over the new block range and calls `decode(ctx, logs, tsOf)` — `logs[key]` holds the logs for the source you keyed. Returned fills are deduped by `id`, bucketed into `byVenue[venueId]` daily volume, and joined to the reference mid for 0/5/10/30/60s markouts. `quote()` rows feed the Execution comparison.
- **Frontend:** `venues()` is served in `state.venues` (+ `GET /api/venues`); the UI renders your venue with zero client-side knowledge of it.

## Notes
- **Multiple venues from one adapter:** return several `VenueMeta` from `venues()` and tag each fill/quote with the right `id` (e.g. a protocol that surfaces both a "spot" and a "vault" venue). The core **validates** this: a fill/quote whose `venueId` isn't one your `venues()` declared is dropped with a note (never silently stored).
- **Unique ids:** venue `id`s must be unique across every adapter + the reference and lowercase kebab-case. The registry is validated at startup — a duplicate/invalid id **throws** (fail-loud), so a collision can't silently merge two venues.
- **Log-source `kind` (failure handling):** classify each `LogSource` — `'fills'` (default, fill-producing) and `'state'` (decoding state, e.g. pool/book `Open`s whose loss makes later fills undecodable) both **hold the block cursor** on a fetch failure: the whole tail cycle is skipped atomically and retried next cycle, so nothing is partially decoded or lost. `'attribution'` (labels only, e.g. router tags) is **tolerated** — the cursor advances and the affected fill just carries degraded attribution (it is not dropped). Don't mislabel state as attribution.
- **Discovery readiness matters:** if `discover()` must enumerate the fill/state contracts, `logSources()` must throw while that discovery state is unavailable. Returning `[]` means the venue truly has no tailable sources; it must not mean "discovery failed".
- **Decode is cursor-critical:** if your `decode()` throws, the core holds the cursor and retries the whole range. Use this for genuinely unsafe states (e.g. authoritative discovery unavailable). For one malformed/irrelevant log, catch locally and skip that log so the indexer doesn't wedge forever.
- **Degraded attribution, not a false label:** when an `'attribution'` source's fetch fails, its key is in `decode`'s `failedSources` — use it so you don't assert a confident class. The Clober adapter tags such Takes **`UNKNOWN`** instead of `DIRECT` (we can't tell direct from routed when the router logs are missing).
- **Self-healing discovery:** `discover()` is re-run periodically (`REDISCOVER_MS`, default 10 min), so missed/mid-run pools recover from your authoritative source. Make `discover()` **merge** into your cache (never replace) so a transient/partial failure can't shrink or wipe it — `poe.ts` and `clober.ts` both do this. NB: POE/Metric discover pools by a factory *read* (no cursor-holding log source), so a brand-new pool created mid-run is only picked up at the next rediscovery; for the tracked registered-pair set that's fine — a venue expecting frequent new pools should expose a `'state'` "pool-created" log source instead.
- **backfill().fills** are persisted to the DB, so they show up in the DB-backed leaderboard/tape (`queryFills`). Contract: their **volume** must come from `backfill().days` (fills are not re-aggregated). **Markouts:** only fills whose horizons are still in the future get aged against the live mid; a historical closed-day fill with `null` markouts is tape-visible but **excluded** from markout/leaderboard stats (never fabricated from a much-later mid). If you can supply final historical markouts, include them in the fill.
- **Stateful discovery:** `discover()` and `decode()` may mutate closure state (e.g. fold newly-`Open`ed pools from a log source into your cache) — see `clober.ts`'s `mergeVaultBooks`.
- **Degrade intentionally:** quote-only failures can return empty rows. Fill/state discovery, required log fetches, timestamp lookup, and unsafe decode states must throw/hold the cursor so volume and fills are never silently undercounted.
- **The CEX references** live in the `ReferenceRegistry` (`reference.ts`, `role: 'reference'`), not in venue adapters: one per base asset (Bybit `MONUSDT` for MON, Binance for BTC/ETH), each converted into the pair's own terms (stable `USDCUSDT` cross + `WBTCBTC` wrap basis — spec §5.5).

## Scope & limits
Both **venues** and the **pair/asset universe** are registry-driven (`@shared`):
- A new **venue** on existing pairs = one adapter file + one `registry.ts` line.
- A new **pair** on an existing base/quote = one `PAIRS` entry (adapters pick up pools for it on the next discovery).
- A new **base asset** = an `ASSETS` entry (CEX routing + `cexSymbol`, optional `wrapBasisSymbol`) + its wrapper in `TOKENS` + `PAIRS` entries + a pool in some adapter. A new **quote stable** = a `TOKENS` entry (+ `usdtCross` where the CEX lists it).
Only quote/emit **registered** pairs (`pairFor`) — an unregistered market has no reference rows or markout routing and the core drops it.
