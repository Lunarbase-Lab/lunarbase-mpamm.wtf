/**
 * One-time historical seed for daily Clober volume (spec Appendix B). The
 * public RPC can't backfill deep history (getLogs is range-capped), so the
 * Goldsky subgraph is used purely as a startup accelerator — never as a live
 * source of truth. The Clober Vault adapter passes registered vault book ids, so
 * the seed uses Σ BookDayData.volumeUSD over exactly the same books live decode
 * accepts, grouped by UTC day.
 *
 * SECURITY: the response is third-party data — treated as numbers only.
 */

export interface CloberDay { venue: number; vault: number; }

async function gql(url: string, query: string): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`subgraph ${res.status}`);
  const j: any = await res.json();
  if (Array.isArray(j?.errors) && j.errors.length) throw new Error(`subgraph GraphQL error: ${j.errors[0]?.message ?? 'unknown'}`);
  return j;
}

/** Sum BookDayData.volumeUSD by UTC day for a specific set of registered
 *  base/stable books, paginating by skip. */
async function sumBookDayData(url: string, bookIds: string[], sinceTs: number): Promise<Map<string, number>> {
  const byDay = new Map<string, number>();
  if (!bookIds.length) return byDay;
  const idset = bookIds.map((i) => `"${i}"`).join(',');
  let skip = 0;
  let pages = 0;
  for (;;) {
    if (++pages > 1000) throw new Error('subgraph pagination exceeded safety cap for bookDayDatas');
    const j = await gql(url, `{ bookDayDatas(first: 1000, skip: ${skip}, orderBy: date, orderDirection: asc, where: { book_in: [${idset}], date_gte: ${sinceTs} }) { date volumeUSD } }`);
    const arr: Array<{ date: number; volumeUSD: string }> | undefined = j?.data?.bookDayDatas;
    if (!Array.isArray(arr)) throw new Error('subgraph response missing bookDayDatas');
    for (const r of arr) {
      const usd = Number(r.volumeUSD);
      if (!Number.isFinite(usd)) throw new Error(`subgraph response has invalid volumeUSD for date ${r.date}`);
      const day = new Date(r.date * 1000).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + usd);
    }
    if (arr.length < 1000) break;
    skip += 1000;
  }
  return byDay;
}

/**
 * Historical Clober daily volume keyed by UTC day, scoped by the caller's book
 * lists. The Clober Vault adapter passes only registered vault books, matching
 * live decode. Throws on transport error.
 */
export async function seedCloberDaily(
  url: string, sinceUtc: string, venueBookIds: string[], vaultBookIds: string[],
): Promise<Map<string, CloberDay>> {
  const sinceTs = Math.floor(Date.parse(sinceUtc + 'T00:00:00Z') / 1000);
  const [venue, vault] = await Promise.all([
    sumBookDayData(url, venueBookIds, sinceTs),
    sumBookDayData(url, vaultBookIds, sinceTs),
  ]);
  const out = new Map<string, CloberDay>();
  for (const [day, v] of venue) out.set(day, { venue: v, vault: 0 });
  for (const [day, v] of vault) {
    const e = out.get(day) ?? { venue: 0, vault: 0 };
    e.vault = v;
    out.set(day, e);
  }
  return out;
}
