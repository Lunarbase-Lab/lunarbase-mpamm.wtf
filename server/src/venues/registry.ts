import type { VenueMeta } from '@shared';
import type { VenueAdapter, ReferenceAdapter } from './adapter.js';
import { createPoeAdapter } from './poe.js';
import { createCloberVaultAdapter } from './clober.js';
import { createMetricAdapter } from './metric.js';
import { createBybitReference } from './bybit-reference.js';

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
];

/** The single CEX reference (markout + Execution benchmark). Exactly one. */
export const REFERENCE: ReferenceAdapter = createBybitReference();

/** Every venue's metadata (all adapters' venues + the reference) — served to the
 *  frontend so it renders venues purely from this, with nothing hardcoded. */
export function venueMeta(): VenueMeta[] {
  return [...ADAPTERS.flatMap((a) => a.venues()), REFERENCE.meta()];
}

/** The set of all registered venue ids (adapters + reference). */
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
    throw new Error(`venue registry: adapter venue '${adapterRefs[0].id}' has role 'reference' — use REFERENCE for the single CEX benchmark`);
  }
  const seen = new Set<string>();
  for (const v of metas) {
    if (!v.id || !/^[a-z0-9][a-z0-9-]*$/.test(v.id)) {
      throw new Error(`venue registry: invalid id ${JSON.stringify(v.id)} for "${v.name}" — use lowercase kebab-case`);
    }
    if (seen.has(v.id)) throw new Error(`venue registry: duplicate venue id '${v.id}' — ids must be unique across every adapter + the reference`);
    seen.add(v.id);
  }
  const refs = metas.filter((v) => v.role === 'reference');
  if (refs.length !== 1) throw new Error(`venue registry: expected exactly one reference (CEX) venue, found ${refs.length}`);
}
