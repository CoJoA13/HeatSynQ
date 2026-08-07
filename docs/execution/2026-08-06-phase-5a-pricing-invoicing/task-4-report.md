# Task 4 Report: `part-prices.ts` — price rows and their breaks

Commit: `feat(parts): price rows keyed by process step code, replacing the part's price columns`

## Verified before starting

Task 2's deletions were confirmed still in place before any work began:
- `src/server/part-price-breaks.ts` — does not exist.
- `tests/part-price-breaks.test.ts` — does not exist.
- `src/app/api/parts/[id]/breaks/route.ts` and `[breakId]/route.ts` — do not exist.
- `PRICING_FIELDS` — zero matches anywhere in `src/` or `tests/`.
- `src/server/parts.ts` — carries no pricing fields (`pricePer`/`unitPrice`/`setupCharge`/`minimumCharge` all absent), and its `deletePart` already cascade-soft-deletes `PartPrice` rows (the code Task 2's reviewer flagged as untested).

Also verified `src/server/audit.ts` already carries `"partPrice" | "partPriceBreak"` in `AuditableModel` and both entries in `SNAPSHOT_INCLUDE` (the pricing-schema commit, `269f525`, added them), and `src/lib/reference-links.ts` already registers `partPrice.processStepCodeId -> processStepCode` — neither needed extending for this task.

## What I implemented

- **`src/server/part-prices.ts`** (new) — `listPartPrices`, `addPartPrice`, `updatePartPrice`, `deletePartPrice`, `addPriceBreak`, `updatePriceBreak`, `deletePriceBreak`, following the deleted `part-price-breaks.ts`'s idiom exactly, per the brief's Step 3:
  - `PartPriceRow` carries `glAccountId`/`glAccountName` read off the price row's step code (`processStepCode.glAccountId` / `.glAccount.name ?? ""`) — the canonical shape in the brief's "Produces" section (the abbreviated type in the brief's own Step-3 code excerpt omits these two fields, but its function body computes them; I followed the canonical interface).
  - `addPartPrice` — Serializable (assigns the registered FK `processStepCodeId`), part-liveness 404, `assertRefExists("processStepCode", …, tx)`, live-rows-only duplicate check via `findFirst` (never `findUnique`).
  - `updatePartPrice` — `claimLivePrice` (scoped `updateMany`, 404 on `count === 0`), Serializable exactly when the patch touches `processStepCodeId` or `pricePer`, re-checks the duplicate-operation rule on a step-code change, and refuses `pricePer: "LOT"` with `LOT_WITH_BREAKS` when live breaks exist.
  - `deletePartPrice` — `auditedSoftDelete`, breaks left untouched (matches `deletePart`'s own cascade comment).
  - `addPriceBreak` / `updatePriceBreak` / `deletePriceBreak` — the deleted file's shape, `partId` swapped for `partPriceId`, with a two-tier scoping read (price row live and belongs to `partId` → 404 "Price row not found"; break live and belongs to `priceId` → 404 "Price break not found") and the LOT refusal read off the price row.
- **Four routes**, copied from `parts/[id]/breaks/(route.ts|[breakId]/route.ts)` and re-pathed/re-scoped:
  - `src/app/api/parts/[id]/prices/route.ts` (GET `parts.view`; POST `parts.edit` + `mustDo(user, "change_prices")`)
  - `src/app/api/parts/[id]/prices/[priceId]/route.ts` (PATCH/DELETE, same gates)
  - `src/app/api/parts/[id]/prices/[priceId]/breaks/route.ts` (POST, same gates)
  - `src/app/api/parts/[id]/prices/[priceId]/breaks/[breakId]/route.ts` (PATCH/DELETE, same gates)

  Every route keeps `mustDo(user, "change_prices")` unconditionally alongside `mustCan(user, "parts", "edit")`.

- **`tests/part-prices.test.ts`** (new) — the brief's seven test cases verbatim, plus one addition (see Self-review below).
- **`tests/parts.test.ts`** (modified) — extended the existing `"delete requires a reason and cascades children in one transaction"` test with a `PartPrice` row and asserted its `deletedAt` and delete-audit reason after `deletePart`, per the brief's explicit instruction to fold this into that test rather than add a new one.

## TDD evidence

**RED** — `npx vitest run tests/part-prices.test.ts`, before `src/server/part-prices.ts` existed:

```
 FAIL  tests/part-prices.test.ts [ tests/part-prices.test.ts ]
Error: Cannot find module '@/server/part-prices' imported from '/home/cjones/Desktop/HeatSynQ/erp/tests/part-prices.test.ts'.
...
 Test Files  1 failed (1)
      Tests  no tests
```

Expected failure: the brief's Step 2 calls for exactly this — module not found, since the service didn't exist yet. This is genuine RED, not a placeholder — the test file imports the seven functions the brief's interface specifies, and the failure is the import itself, not an assertion.

**GREEN** — `npx vitest run tests/part-prices.test.ts`, after implementing `src/server/part-prices.ts` (and `npx prisma generate`, needed for the `Prisma.PartPriceUpdateManyMutationInput`/`Prisma.PartPriceBreakUpdateManyMutationInput` types used by the two `claimLive*` helpers):

```
 ✓ tests/part-prices.test.ts (8 tests) 426ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
```

`tests/parts.test.ts` (the cascade addition) also green on its own: `✓ tests/parts.test.ts (18 tests) 946ms`.

## Gates (all from `erp/`, Node 26)

| Gate | Result |
|---|---|
| `npm test` | Pass — **99 test files, 1433 tests, all passing**, including `tests/part-prices.test.ts` (8/8) and the extended `tests/parts.test.ts` (18/18). Output pristine. |
| `npx tsc --noEmit` | Pass — zero errors. No phantom `api/parts/[id]/breaks` entries appeared (ran once before `npm run build` and once after; both clean). |
| `npx eslint src tests` | Pass — zero warnings/errors. |
| `npm run build` | Pass — standalone build succeeded; route table lists all four new endpoints (`/api/parts/[id]/prices`, `/api/parts/[id]/prices/[priceId]`, `/api/parts/[id]/prices/[priceId]/breaks`, `/api/parts/[id]/prices/[priceId]/breaks/[breakId]`). |
| `npx vitest run tests/reference-links-sweep.test.ts tests/partial-unique-sweep.test.ts tests/permissions-sweep.test.ts` | Pass — 17/17 (Step 7). |

## Files changed

- `erp/src/server/part-prices.ts` (new)
- `erp/src/app/api/parts/[id]/prices/route.ts` (new)
- `erp/src/app/api/parts/[id]/prices/[priceId]/route.ts` (new)
- `erp/src/app/api/parts/[id]/prices/[priceId]/breaks/route.ts` (new)
- `erp/src/app/api/parts/[id]/prices/[priceId]/breaks/[breakId]/route.ts` (new)
- `erp/tests/part-prices.test.ts` (new)
- `erp/tests/parts.test.ts` (modified — cascade test extended)

## Self-review findings

- **One test beyond the brief's listed seven**: `"adds, updates, and deletes a price break, scoped to its price row"` in `tests/part-prices.test.ts`. The brief's own test list never exercises `updatePriceBreak`/`deletePriceBreak` or the breaks read-back through `listPartPrices`, even though Step 3 explicitly requires implementing those three functions with a two-tier scoping check. Without this test, `updatePriceBreak`/`deletePriceBreak` and their "Price row not found" vs. "Price break not found" distinction would have zero coverage, and a regression there would pass every other test in the suite. I judged the coverage gap worth one added test over strict verbatim-only compliance; flagging it here rather than deciding silently, since the brief says to use its test cases "verbatim." No production code or requirement was added beyond what Step 3 already specifies — this is test-only.
- Confirmed `glAccountId`/`glAccountName` on `PartPriceRow` match the canonical "Produces" interface (not the abbreviated type in the Step-3 code excerpt) — the `listPartPrices` function body in the brief already computes both fields, so the excerpt's type was clearly just truncated for brevity.
- Confirmed every mutator uses `findFirst({ …, deletedAt: null })`, never `findUnique`/`upsert`, on the `(partId, processStepCodeId)` and `(partPriceId, threshold)` partial-unique pairs.
- Confirmed the Serializable/non-Serializable split on `updatePartPrice` matches the write-skew reasoning: Serializable exactly when the patch could race against `addPriceBreak`'s LOT read (`pricePer` change) or assigns the FK (`processStepCodeId` change); no isolation bump for a plain `unitPrice`/`position` edit.
- Confirmed child routes 404 rather than resolve when a price/break id is valid but scoped to the wrong parent (`"scopes every mutator"` test, plus the added breaks test's cross-part check).
- No client component touches `src/server/**`; the four new routes are server-only and were exercised by the full test suite (indirectly, since the sweeps directory-walk them) and by `npm run build`'s route-table generation. I did not write dedicated route-level tests (e.g. in `tests/parts-routes.test.ts`) — the brief's file list names only `tests/part-prices.test.ts`, and the permissions/reference sweeps already assert every route calls `requireUser`/`mustCan`/`mustDo`.

## Concerns

None blocking. The one deviation (the added breaks-CRUD test) is called out above for visibility rather than silently included.
