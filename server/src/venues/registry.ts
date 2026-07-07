import type { VenueMeta } from '@shared';
import type { VenueAdapter, ReferenceRegistry } from './adapter.js';
import { createPoeAdapter } from './poe.js';
import { createCloberVaultAdapter } from './clober.js';
import { createMetricAdapter } from './metric.js';
import { createHanjiAdapter } from './hanji.js';
import { createReferenceRegistry } from './reference.js';

/**
 * The venue registry — the ONE place venues are wired in.
 *
 * This dashboard is dedicated to propAMM-style venues (oracle/MM-priced), not
 * passive curve DEXes or raw CLOBs. To plug in a protocol: drop an adapter file
 * next to poe.ts / metric.ts, then add one line to ADAPTERS below. Nothing else
 * in the core changes — the indexer, DB, API and frontend are all venue-agnostic
 * and read everything (name, color, output) from the adapter. See ADAPTERS.md.
 */
export const ADAPTERS: VenueAdapter[] = [
  createPoeAdapter(),
  createCloberVaultAdapter(),
  createMetricAdapter(),
  createHanjiAdapter(),
];

/** The CEX reference registry — the markout + Execution benchmarks, routed per
 *  base asset (Bybit for MON, Binance for BTC/ETH). At least one, all reference. */
export const REFERENCES: ReferenceRegistry = createReferenceRegistry();

/** Every venue's metadata (all adapters' venues + every CEX reference) — served to
 *  the frontend so it renders venues purely from this, with nothing hardcoded. */
export function venueMeta(): VenueMeta[] {
  return [...ADAPTERS.flatMap((a) => a.venues()), ...REFERENCES.metas()];
}

/** The set of all registered venue ids (adapters + references). */
export function venueIds(): Set<string> {
  return new Set(venueMeta().map((v) => v.id));
}

/**
 * Fail loud on a misconfigured registry — a plugin whose id collides with
 * another's would silently MERGE two venues' data, and a malformed id would
 * break the DB key / frontend lookup. Call once at startup (live + sim).
 */
export function validateRegistry(): void {
  const metas = venueMeta();
  const adapterRefs = ADAPTERS.flatMap((a) => a.venues()).filter((v) => v.role === 'reference');
  if (adapterRefs.length) {
    throw new Error(`venue registry: adapter venue '${adapterRefs[0].id}' has role 'reference' — CEX benchmarks belong in the reference registry`);
  }
  const seen = new Set<string>();
  for (const v of metas) {
    if (!v.id || !/^[a-z0-9][a-z0-9-]*$/.test(v.id)) {
      throw new Error(`venue registry: invalid id ${JSON.stringify(v.id)} for "${v.name}" — use lowercase kebab-case`);
    }
    if (seen.has(v.id)) throw new Error(`venue registry: duplicate venue id '${v.id}' — ids must be unique across every adapter + reference`);
    seen.add(v.id);
  }
  const refs = metas.filter((v) => v.role === 'reference');
  if (refs.length < 1) throw new Error('venue registry: expected at least one reference (CEX) venue, found 0');
}
