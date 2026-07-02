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
