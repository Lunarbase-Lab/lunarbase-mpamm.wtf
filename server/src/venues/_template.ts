import type { Fill, QuoteRow, VenueMeta } from '@shared';
import type { VenueAdapter, AdapterContext, LogBundle } from './adapter.js';

/**
 * ADAPTER TEMPLATE — copy this file, rename it (e.g. `myvenue.ts`), fill in the
 * TODOs, and add one line to `registry.ts`. Nothing else in the core changes.
 * Delete the methods/patterns you don't need. Full guide: ADAPTERS.md.
 *
 * Three sourcing patterns (mix freely):
 *   A. on-chain only  — discover + logSources + decode, NO backfill (like LFJ).
 *   B. subgraph seed + on-chain tail — add backfill() (like Clober Vault).
 *   C. quote-only     — implement quote(); return [] from logSources()/decode().
 */

// 1) Describe your venue(s). `id` is the stable key used everywhere (Fill.venueId,
//    QuoteRow.venueId). `color` per theme is the ONE source of truth the frontend
//    reads — no color is hardcoded client-side. An adapter may return more than
//    one venue (tag each fill/quote with the matching id).
const MY_VENUE: VenueMeta = {
  id: 'my-venue',
  name: 'My Venue',
  color: { light: '#3366FF', dark: '#88AAFF' },
  kind: 'amm',      // 'amm' | 'clob' | 'vault' | 'cex'
  role: 'venue',    // 'venue' for a propAMM/on-chain venue ('reference' is CEX-only)
};

/** viem AbiEvent lookup helper (for logSources). */
const ev = (abi: readonly unknown[], name: string) => abi.find((x: any) => x.type === 'event' && x.name === name);

export function createTemplateAdapter(): VenueAdapter {
  // adapter-private state (discovered markets/pools/books). Held on the closure.
  let markets: unknown[] = [];

  return {
    venues: () => [MY_VENUE],

    // Find your markets/pools. Use ctx.client (viem read/multicall) and/or fetch
    // a subgraph. Stash what you need on the closure state above.
    async discover(ctx: AdapterContext) {
      // markets = await ctx.client.readContract({ ... });   // on-chain
      // markets = (await (await fetch(ctx.config.subgraphUrl, { ... })).json()).data.pools;  // subgraph
      ctx.log(`${MY_VENUE.name}: discovered ${markets.length} market(s)`);
    },

    // (Pattern B) OPTIONAL historical seed — closed-day volume and/or fills.
    // DELETE this whole method for on-chain-only venues (they build forward).
    async backfill(ctx: AdapterContext, sinceUtc: string) {
      // const rows = await fetchDailyVolume(ctx.config.subgraphUrl, sinceUtc);
      // return { days: rows.map((r) => ({ utcDay: r.day, byVenue: { [MY_VENUE.id]: { usd: r.usd } } })) };
      return {};
    },

    // (Pattern C) OPTIONAL live bid/ask for the Execution tab. One QuoteRow per
    // (market,size) you can quote. bid/ask are bps vs the reference mid; px is
    // quote-per-base (stable per MON). Set venueId to your venue id.
    async quote(ctx: AdapterContext, sizesUsd: readonly number[]): Promise<QuoteRow[]> {
      const rows: QuoteRow[] = [];
      // const mid = ctx.referenceMid();
      // for (const market of markets) for (const sizeUsd of sizesUsd) {
      //   const { bidPx, askPx, filledFull } = await readYourQuoter(ctx.client, market, sizeUsd);
      //   rows.push({ venueId: MY_VENUE.id, market, sizeUsd,
      //     bidPx, askPx, bidBps: (bidPx/mid-1)*1e4, askBps: (askPx/mid-1)*1e4,
      //     spreadBps: (askPx-bidPx)/mid*1e4, filledFull, feeBps: 0, ts: Date.now() });
      // }
      return rows;
    },

    // Declare the contract logs the core fetches each cycle (read AFTER discover,
    // so pool addresses are known). `events` are viem AbiEvent objects. The core
    // getLogs's these over the new block range and returns them to decode() by key.
    logSources() {
      // return [{ key: 'swap', address: MY_POOL_ADDRESS, events: [ev(myAbi, 'Swap')] }];
      void ev;
      return [];
    },

    // Turn your fetched logs into normalized fills. `logs[key]` matches your
    // logSources keys; `tsOf(blockNumber)` → block timestamp (ms). Own any
    // venue-specific correlation here (router maps, mid-run pool discovery, …).
    decode(_ctx: AdapterContext, logs: LogBundle, tsOf: (bn: bigint) => number): Fill[] {
      const out: Fill[] = [];
      for (const l of logs.swap ?? []) {
        // decode l → usd (stable leg), baseAmount (MON), execPx (quote-per-base), side, market:
        // out.push({
        //   id: `mv-${l.transactionHash.toLowerCase()}-${l.logIndex}`,  // deterministic (txHash:logIndex) so re-tail dedupes
        //   venueId: MY_VENUE.id, market, side, category: 'DIRECT',
        //   usd, baseAmount, execPx, txHash: l.transactionHash, to, pool,
        //   blockNumber: Number(l.blockNumber), ts: tsOf(l.blockNumber),
        //   markoutsBps: [null, null, null, null, null],  // the core ages these vs the reference
        // });
        void l; void tsOf;
      }
      return out;
    },
  };
}
