<!-- For a NEW VENUE ADAPTER, fill in both sections below (guide: docs/adapters.md).
     For any other change, delete the venue section and describe the change. -->

## What

<!-- One paragraph: what this PR adds/changes and why. -->

---

## New venue adapter

**About the venue** (helps review go fast):

- How the venue qualifies as a **propAMM** — who sets the price (the maker/oracle mechanism), and its structure (oracle-anchored AMM / vault-quoted order book / JIT vault). Passive curve DEXes and raw CLOBs are out of scope (docs/spec.md D3):
- Who runs the quoting keeper (and who pays for quote updates):
- Docs / audits / contract source:

**Checklist** (from [docs/adapters.md](../docs/adapters.md) — reviewers apply this):

- [ ] One adapter file + one `registry.ts` line (+ `@shared` pair/token entries if adding markets); **no core edits**
- [ ] `venues()` meta: unique kebab-case `id`, both theme colors (distinct + CVD-safe vs the existing palette), `sinceUtc` = real first-activity day, `backfillFromUtc` set
- [ ] Only **registered pairs** emitted; **deterministic fill ids** (`venue-txHash-logIndex`); `pxApprox` where the realized price isn't real
- [ ] Log sources classified (`fills` / `state` / `attribution`); `logSources()` throws pre-discovery when needed; `discover()` **merges**, never replaces
- [ ] `gasSources()` declared — or explicitly omitted with a comment saying who pays for quote updates and why it's not the venue
- [ ] Fees read **on-chain**, not hardcoded from docs
- [ ] Units hand-verified against a real fill — link the tx and show the math:
- [ ] Fixture decode tests added (`server/src/venues/__tests__/`, real recorded logs, no network)
- [ ] `npm run typecheck` and `npm -w server run test` green
- [ ] `npm -w server run verify-adapter -- <id>` output pasted below

<details>
<summary>verify-adapter output</summary>

```
(paste here)
```

</details>
