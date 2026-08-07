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
## Fix wave 1

Reviewer findings on Task 4 (`part-prices.ts`, commit `e0cfa77`): five fixes, all applied. Details below.

### Finding 1 (IMPORTANT) — zero executed coverage of the `change_prices` gate

Added `tests/parts-routes.test.ts`, new test `"price and price-break routes gate on parts.edit AND change_prices"`. Follows the file's existing idiom (`partFixture`, `withParams`, `bodyReq`/`noBodyReq`, `signInWith`) rather than inventing a new one, imported the four route files' handlers alongside the existing parts-child-route imports. Covers all six `change_prices`-gated endpoints across the four files: `POST .../prices`, `PATCH .../prices/[priceId]`, `DELETE .../prices/[priceId]`, `POST .../breaks`, `PATCH .../breaks/[breakId]`, `DELETE .../breaks/[breakId]` — each asserted 401 (no cookie), 403 (`parts.edit` only, via `signInWith(["parts.edit"], ...)`), 200 (`parts.edit` + `action.change_prices`, via `signInWith(["parts.edit", "action.change_prices"], ...)`).

Command: `npx vitest run tests/parts-routes.test.ts`
Output:
```
 ✓ tests/parts-routes.test.ts (21 tests) 4174ms

 Test Files  1 passed (1)
      Tests  21 passed (21)
```

**Discrimination proof** — per the brief, temporarily deleted the `mustDo(user, "change_prices")` line (and its comment) from `src/app/api/parts/[id]/prices/route.ts`'s `POST` handler, then ran the new test alone.

Command: `npx vitest run tests/parts-routes.test.ts -t "price and price-break routes gate"` (with the `mustDo` line removed)
Output (FAILURE, confirming the test discriminates):
```
 FAIL  tests/parts-routes.test.ts > parts routes > price and price-break routes gate on parts.edit AND change_prices
AssertionError: expected 200 to be 403 // Object.is equality

- Expected
+ Received

- 403
+ 200

 ❯ tests/parts-routes.test.ts:466:44
    464|     expect((await addPriceRoute(
    465|       bodyReq(`http://t/api/parts/${partId}/prices`, "POST", editOnly,…
    466|       withParams({ id: partId }))).status).toBe(403);

 Test Files  1 failed (1)
      Tests  1 failed | 20 skipped (21)
```

Restored the `mustDo` line (`git diff` on the route file confirmed a clean no-op afterward), re-ran the same command.
Output (PASS):
```
 ✓ tests/parts-routes.test.ts (21 tests | 20 skipped) 395ms
   ✓ parts routes > price and price-break routes gate on parts.edit AND change_prices  394ms

 Test Files  1 passed (1)
      Tests  1 passed | 20 skipped (21)
```

### Finding 2 (Minor) — untested second scoping tier ("Price break not found")

Added `tests/part-prices.test.ts`, new test `"404s 'Price break not found' for a break on a different price row of the same part"`. Creates two live price rows on the SAME part, adds a break to the first, then calls `updatePriceBreak`/`deletePriceBreak` with the second price row's id and the first row's break id — a same-part, wrong-price-row id — and asserts `"Price break not found"` specifically (not the first-tier `"Price row not found"` the existing test only ever exercised).

Command: `npx vitest run tests/part-prices.test.ts`
Output:
```
 ✓ tests/part-prices.test.ts (11 tests) 554ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

### Finding 3 (Minor) — untested step-code-change branch

Added `tests/part-prices.test.ts`, new test `"changes a price row's step code, and the duplicate re-check catches a collision on that change"`. Adds a price row on one step code, calls `updatePartPrice` to move it to a second (unused) step code, and reads it back through `listPartPrices` to confirm both `processStepCodeId` and the joined `stepCode` moved. Then adds a second price row on a third step code and attempts to `updatePartPrice` it onto the now-occupied second step code, asserting the duplicate re-check (`part-prices.ts:126-135`) refuses with `"That operation is already priced on this part"`. Covered by the same run above (11/11 passing).

### Finding 4 (Minor) — stale comment

`src/server/part-prices.ts:100-101`: changed `"the claimLive precedent (parts.ts, part-price-breaks.ts)"` to `"the claimLive precedent (part-inspections.ts:80)"` — `part-price-breaks.ts` no longer exists (deleted in `269f525`); `part-inspections.ts:80` carries the actual live precedent comment (`"Writes only if still live and still scoped to this part, one statement — the claimLive precedent (parts.ts)."`, confirmed by reading that file). `parts.ts` itself was dropped from the citation since it's the referent one hop further back, not the direct precedent.

### Finding 5 (Minor) — untested duplicate-threshold refusals

Added `tests/part-prices.test.ts`, new test `"refuses a duplicate threshold on add and on update"`. Adds a break at threshold 500 on a price row, then asserts `addPriceBreak` at the same threshold refuses (`part-prices.ts:171`); adds a second break at threshold 1000, then asserts `updatePriceBreak` moving it to threshold 500 also refuses (`part-prices.ts:202-208`) — both against `"A price break with that threshold already exists"`. Covered by the same run above (11/11 passing).

## Full gate run

```
npx tsc --noEmit         # clean, zero errors
npx eslint src tests     # clean, zero warnings/errors
npm test                 # 99 test files, 1437 tests, all passing (1433 baseline + 4 new: 3 in
                          # part-prices.test.ts, 1 in parts-routes.test.ts)
```

## Files changed

- `erp/src/server/part-prices.ts` (comment fix only, finding 4)
- `erp/tests/part-prices.test.ts` (3 new tests, findings 2/3/5)
- `erp/tests/parts-routes.test.ts` (1 new test + 5 new imports, finding 1)

## Not done (explicitly out of scope)

Per the brief, no guard was added for `updatePartPrice` silently reinterpreting `threshold` when moving a price row EACH → LB → PER_1000 while live breaks exist. The task owner is carrying that forward themselves as a design question for Task 5's UI and Task 9's pricing.
