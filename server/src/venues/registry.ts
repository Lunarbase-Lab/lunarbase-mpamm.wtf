import type { VenueMeta } from '@shared';
import type { VenueAdapter, ReferenceAdapter } from './adapter.js';
import { createLfjAdapter } from './lfj.js';
import { createCloberVaultAdapter } from './clober.js';
import { createBybitReference } from './bybit-reference.js';

/**
 * The venue registry — the ONE place venues are wired in.
 *
 * To plug in a protocol: drop an adapter file next to lfj.ts / clober.ts, then
 * add one line to ADAPTERS below. Nothing else in the core changes — the
 * indexer, DB, API and frontend are all venue-agnostic and read everything
 * (name, color, output) from the adapter. See ADAPTERS.md + _template.ts.
 */
export const ADAPTERS: VenueAdapter[] = [
  createLfjAdapter(),
  createCloberVaultAdapter(),
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
  const seen = new Set<string>();
  for (const v of metas) {
    if (!v.id || !/^[a-z0-9][a-z0-9-]*$/.test(v.id)) {
      throw new Error(`venue registry: invalid id ${JSON.stringify(v.id)} for "${v.name}" — use lowercase kebab-case`);
    }
    if (seen.has(v.id)) throw new Error(`venue registry: duplicate venue id '${v.id}' — ids must be unique across every adapter + the reference`);
    seen.add(v.id);
  }
  if (!metas.some((v) => v.role === 'reference')) throw new Error('venue registry: no reference (CEX) venue registered');
}
