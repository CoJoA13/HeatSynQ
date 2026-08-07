# Task 6 report — `surcharges.ts`: definitions, step-code list, customer overrides

## What was implemented

`src/server/surcharges.ts` (new), exactly the interface the brief specified:

- `listSurcharges(opts?)` — live surcharges (active-only unless `includeInactive`), ordered by
  `position` then `id`, with GL account name and the flattened `stepCodeIds` list.
- `createSurcharge(input)` / `updateSurcharge(id, input)` — `createStepCode`/`updateStepCode`'s
  shape verbatim (`process-step-codes.ts:86-119`): `findFirst` on the live name (partial unique,
  never `findUnique`), conditional Serializable only when `glAccountId` is actually assigned,
  `assertRefExists("glAccount", …, tx)` inside that same transaction. The PERCENT/FLAT ↔
  rate/amount consistency rule lives entirely in a zod `.superRefine` (`SAVE`), not in either
  function body, exactly as the brief specifies.
- `deleteSurcharge(id)` — `deleteStepCode`'s shape verbatim: blocker scan and soft delete inside
  one Serializable transaction, refusing with
  `` `That ${TARGET_LABELS.surcharge} is still in use by ${blockers.length} record(s)` ``.
- `setSurchargeStepCodes(id, stepCodeIds)` — replace grid (`deleteMany` + `createMany`, no soft
  delete — `SurchargeStepCode` has no `deletedAt`), wrapped in one `auditedUpdate("surcharge", …)`
  so the replacement is one audit row, `assertRefExists("processStepCode", …, tx)` per id,
  Serializable. Added a small guard rejecting a duplicate id in the same call (not brief-specified,
  see Concerns).
- `listCustomerSurcharges(customerId)` / `setCustomerSurcharge(customerId, surchargeId, input)` —
  the customer's override rows (only surcharges with an actual override — a customer with none
  simply bills at the plant-wide definition, which is Task 9's job to resolve). `setCustomerSurcharge`
  is a `findFirst`-then-create-or-update upsert on the `(customerId, surchargeId)` partial-unique
  pair (never `upsert`/`findUnique`), Serializable throughout since `surchargeId` is always a
  freshly-checked FK.

`src/lib/reference-links.ts` — Step 3 of the brief, applied verbatim: `BlockerTarget` widened to
include `"surcharge"`, `TARGET_LABELS` gains `surcharge: "surcharge"`, `ReferenceLinkModel` gains
`"customerSurcharge"`, and the two new registry entries (`customerSurcharge.surchargeId` and
`invoiceLine.surchargeId`, both `-> surcharge`) exactly as specified.

`tests/reference-links-sweep.test.ts` — `kinds.add("surcharge")` beside the existing
`kinds.add("processStepCode")`, plus the necessary knock-on updates (see "Unplanned finding"
below) and two new bite-proof fixture tests I added for the new exemption path.

## Unplanned finding: `SurchargeStepCode.surchargeId` needed an `onDelete: Cascade` fix

Adding `"surcharge"` to `schemaLinks`'s `kinds` set (as instructed) surfaced a real gap the brief
didn't anticipate: `SurchargeStepCode` has **two** FKs — `processStepCodeId` (correctly already a
registered usage blocker) and `surchargeId` (its actual parent). Once `surcharge` became a swept
kind, `surchargeStepCode.surchargeId -> surcharge` started failing the sweep as an "unregistered
usage FK." But this FK is not a usage reference — `SurchargeStepCode` is a replace-grid row
*owned* by its `Surcharge`, managed entirely by `setSurchargeStepCodes` (delete-all,
recreate-all). Registering it as a real blocker would have made a surcharge's own
INCLUDE/EXCLUDE step-code list block that surcharge's own deletion — the same
self-referential dead end the codebase already avoids for `ProcessStepFieldDef.codeId ->
ProcessStepCode` via an `onDelete: Cascade` annotation that the sweep's `schemaLinks` treats as
an "owned child, not a usage FK" exemption.

`SurchargeStepCode.surchargeId` was simply missing that same annotation (unlike its sibling
`processStepCodeId`, which correctly has none, since that FK IS a real usage reference). I:

1. Added `onDelete: Cascade` to `Surcharge.surcharge` relation field on `SurchargeStepCode`, with
   a schema comment explaining why (mirrors `ProcessStepFieldDef.codeId`'s comment).
2. Created migration `20260807024446_surcharge_step_code_cascade` (pure `DROP
   CONSTRAINT`/`ADD CONSTRAINT` changing only the FK's `ON DELETE` clause — no data change,
   purely additive/non-destructive) via the `create-migration` skill's TTY-less flow, applied to
   both `erp` and `erp_test`, regenerated the client, verified `migrate status` clean on both.
3. Widened `schemaLinks`'s owned-child exemption (in the test file, not app code) from
   "targets `processStepCode`" to "targets `processStepCode` or `surcharge`", with an updated
   doc comment.
4. Added two new bite-proof fixture tests mirroring the existing `ProcessStepCode` ones: one
   proving the `Surcharge`-targeting cascade FK is correctly exempt, one proving a *non*-cascade
   FK targeting `Surcharge` (the `CustomerSurcharge`/`InvoiceLine` shape) is still correctly
   reported — so the exemption is proven keyed off the annotation, not the target kind alone.

This is a schema change and a migration the brief's file list didn't mention, but it's a strict
requirement of the sweep change the brief DID ask for (`kinds.add("surcharge")`), it never touches
any table other than `SurchargeStepCode`, and it follows the codebase's own established precedent
exactly. Flagging prominently per instructions.

## Design decision: `updateSurcharge` takes the full `SAVE` shape, not a partial patch

Several other services in this codebase (`updatePartPrice`, `updatePartInspection`,
`updateStepCode`) accept a **partial** patch for updates. I did not do that here, deliberately.

The brief states: *"The kind/amount consistency rules live in a zod `.superRefine`, not in the
service body."* A partial patch can't be validated for kind/rate/amount consistency by a
superRefine alone — you'd need to merge the patch against the row's current live state first
(the `updatePartInspection`/min-max precedent), and that merge-then-validate logic necessarily
lives in the service body, not the schema. Making `updateSurcharge` accept the same full `SAVE`
shape as `createSurcharge` keeps the rule genuinely singular (in the schema, full stop) and
avoids inventing merge logic the brief didn't ask for.

Trade-off, stated plainly: this makes `updateSurcharge` a whole-row "form save" rather than a
sparse patch — a caller must resend `name`/`kind`/`position` (and, implicitly, `rate` or `amount`
per the active `kind`) on every update, not just the field being changed. No test in the brief
exercises `updateSurcharge` at all, so this is an interpretation call, not something verified by
the given test suite. If the intended UI is a small per-row form that already always submits the
whole row (matching how `part-prices` rows are edited), this is a non-issue; if a future task
needs sparse PATCH semantics, this will need revisiting — happy to switch to a partial-plus-merge
shape if that's the actual intent.

## Minor addition: duplicate-id guard in `setSurchargeStepCodes`

Not requested by the brief, but `SurchargeStepCode` has a **real** (non-partial) `@@unique([surchargeId,
processStepCodeId])` — a caller passing the same step-code id twice in one call would hit a raw
`P2002` translated through the generic `entity: "Surcharge"` `withDbErrors` call, producing a
misleading "A surcharge with that value already exists" message. Added
`if (new Set(ids).size !== ids.length) throw new HttpError(400, "Duplicate step code in the list")`
ahead of the transaction — three lines, field-anchored message, consistent with existing
array-input guards elsewhere (e.g. `FIELDS_ARRAY`'s duplicate-sort check in
`process-step-codes.ts`).

## `AuditableModel` / `SNAPSHOT_INCLUDE`

**Already done by Task 2.** Verified against the tree before writing any code:
`src/server/audit.ts`'s `AuditableModel` already includes `"surcharge" | "surchargeStepCode" |
"customerSurcharge"`, and `SNAPSHOT_INCLUDE` already carries:

```ts
surcharge: {
  stepCodes: { orderBy: { processStepCodeId: "asc" }, include: { processStepCode: { select: { code: true, name: true } } } },
  glAccount: { select: { name: true } },
},
surchargeStepCode: undefined,
customerSurcharge: { surcharge: { select: { name: true } } },
```

Both already carry deterministic `orderBy` on the one collection (`stepCodes`), so issue #24
(unordered-collection spurious diffs) is already closed for this entity. No changes made here.

## TDD evidence

### RED — `npx vitest run tests/surcharges.test.ts` (before `src/server/surcharges.ts` existed)

```
 RUN  v3.2.7 /home/cjones/Desktop/HeatSynQ/erp

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/surcharges.test.ts [ tests/surcharges.test.ts ]
Error: Cannot find module '@/server/surcharges' imported from '/home/cjones/Desktop/HeatSynQ/erp/tests/surcharges.test.ts'.

- If you rely on tsconfig.json's "paths" to resolve modules, please install "vite-tsconfig-paths" plugin to handle module resolution.
- Make sure you don't have relative aliases in your Vitest config. Use absolute paths instead. Read more: https://vitest.dev/guide/common-errors
 ❯ tests/surcharges.test.ts:4:1
      2| import { prisma, truncateAll } from "./helpers/db";
      3| import { runWithContext } from "@/server/context";
      4| import {
       | ^
      5|   listSurcharges, createSurcharge, deleteSurcharge, setSurchargeStepCo…
      6| } from "@/server/surcharges";

 Test Files  1 failed (1)
      Tests  no tests
```

Expected failure: the six tests from the brief were written first, against a module that didn't
exist yet — a clean "module not found," not a logic failure, confirming the test file itself was
wired correctly before any implementation existed.

A second RED also occurred mid-task, in `tests/reference-links-sweep.test.ts`, after widening
`BlockerTarget`/adding the two registry entries but before the `onDelete: Cascade` schema fix:

```
 FAIL  tests/reference-links-sweep.test.ts > reference links sweep > every schema foreign key pointing at a reference table is registered
AssertionError: … expected [ Array(1) ] to deeply equal []
+ [
+   "surchargeStepCode.surchargeId -> surcharge",
+ ]

 FAIL  tests/reference-links-sweep.test.ts > reference links sweep > finds every known reference FK when nothing is registered
AssertionError: expected [ …(26) ] to deeply equal [ …(25) ]
+   "surchargeStepCode.surchargeId -> surcharge",

 Test Files  1 failed (1)
      Tests  2 failed | 8 passed (10)
```

This was the unplanned finding described above — expected once `kinds.add("surcharge")` landed,
and resolved by the schema/migration fix plus the widened owned-child exemption.

### GREEN

`npx vitest run tests/surcharges.test.ts tests/reference-links-sweep.test.ts`:

```
 RUN  v3.2.7 /home/cjones/Desktop/HeatSynQ/erp

 ✓ tests/surcharges.test.ts (6 tests) 355ms
 ✓ tests/reference-links-sweep.test.ts (12 tests) 4ms

 Test Files  2 passed (2)
      Tests  18 passed (18)
```

Full suite, `npm test` (`npx vitest run`):

```
 Test Files  100 passed (100)
      Tests  1453 passed (1453)
   Duration  130.60s
```

Zero regressions across the whole suite (previously-passing files like
`tests/partial-unique-sweep.test.ts`, `tests/reference-blockers.test.ts`, and
`tests/reference-gl.test.ts` all still pass unmodified).

`npx tsc --noEmit` — clean, no output.

`npx eslint src tests` — clean, no output.

## Files changed

- `src/server/surcharges.ts` (new) — the service.
- `tests/surcharges.test.ts` (new) — the six brief-specified tests.
- `src/lib/reference-links.ts` — `BlockerTarget`/`TARGET_LABELS`/`ReferenceLinkModel` widened,
  two new registry entries (`customerSurcharge.surchargeId`, `invoiceLine.surchargeId`).
- `tests/reference-links-sweep.test.ts` — `kinds.add("surcharge")`, widened owned-child
  exemption, updated expected-FK list, two new bite-proof fixture tests.
- `prisma/schema.prisma` — `SurchargeStepCode.surchargeId` relation gains `onDelete: Cascade`
  (see "Unplanned finding" above).
- `prisma/migrations/20260807024446_surcharge_step_code_cascade/migration.sql` (new) — the
  corresponding `DROP CONSTRAINT`/`ADD CONSTRAINT` migration, applied to both `erp` and
  `erp_test`.

## Self-review

- **Completeness:** all six interface functions implemented; all six brief-specified tests pass;
  the Task 2 review carry-forward item (`SURCHARGE_VIA_STEP_CODE`'s `displayName`/`blockerId`
  actually exercised) is covered by the sixth test, which now runs and passes.
- **Quality:** every mutating function follows an existing, reviewed precedent
  (`process-step-codes.ts`, `part-prices.ts`, `users.ts`'s `setUserOverrides`) rather than
  inventing new shapes. Comments point at the precedent being followed, not just restate the code.
- **Discipline:** no route handlers, no UI — the brief's Files list is exactly what was touched,
  plus the one unavoidable schema/migration fix (flagged, not silently absorbed) and one 3-line
  duplicate-id guard (flagged, not silently absorbed).
- **Testing:** all six tests fail meaningfully if the behavior regresses — e.g. the PERCENT/FLAT
  test would pass vacuously only if the `superRefine` were deleted entirely, which would also
  break the create test's `rate`/`amount` round-trip; the delete-blocker tests assert both the
  refusal message AND `findBlockers`'s actual entityLabel/name content, not just "it threw."

## Concerns for the reviewer

1. **`updateSurcharge`'s full-row-vs-partial-patch shape** — see "Design decision" above. This is
   an interpretation of an ambiguous brief instruction, untested by the brief's own test list.
2. **The `onDelete: Cascade` schema/migration fix** — a necessary, correctly-precedented, but
   unplanned change touching a file (`prisma/schema.prisma`) outside the brief's stated file list.
3. **The duplicate-step-code-id guard** in `setSurchargeStepCodes` — a small addition beyond the
   brief's literal text, justified by an otherwise-misleading error message on a real unique
   constraint.

## Fix wave 1

Review findings on `fb7a2d9` fixed, in the order the review specified. All fixes are in
`src/server/surcharges.ts`; all new/changed tests are in `tests/surcharges.test.ts`.

### Fix 1 — `updateSurcharge` persisted only the sent keys, not the validated row

**Change.** Added `toSurchargeRow(data: z.infer<typeof SAVE>)`, a helper that pins every optional
`SAVE` column to its explicit empty value (`rate: data.rate ?? null`, `amount: data.amount ??
null`, `minimumAmount: data.minimumAmount ?? null`, `glAccountId: data.glAccountId ?? null`,
`scope: data.scope ?? "ALL"`, `active: data.active ?? true`) instead of leaving an absent key
absent. `updateSurcharge` now writes `toSurchargeRow(data)`, not `data` itself, so the persisted
row equals the exact row `SAVE`'s superRefine validated. `createSurcharge` was switched to the
same helper too — `create` already got equivalent behavior for free from Prisma's own `@default`
handling on an absent key, and the helper's literals are exactly those defaults, so this costs
nothing and keeps one function (not two) owning "what does an omitted field mean." The audited
`after` payload on create now reflects the normalized row as well (previously it was the raw,
possibly-sparse zod output), which is a strict improvement in audit-content accuracy.

**Approach chosen: normalize-on-write, not merge-then-validate.** The brief's own design decision
(a full-row `SAVE` shape, not a partial patch, so the kind/rate/amount consistency rule lives
only in `SAVE`'s superRefine) was ruled sound by the review — nothing about Fix 1 asked to revisit
it. Merge-then-validate would mean re-reading the live row, merging the patch onto it, and running
`SAVE` against the merged object — which reintroduces exactly the "service body re-derives merged
state to re-validate a partial one" shape the original design decision was written to avoid, for a
function whose brief explicitly wants a whole-row save. Normalize-on-write keeps the fix local (one
small helper, no behavior change to what a caller must send) and keeps the single source of truth
for field-consistency in the schema, not the service body.

**RED** (`npx vitest run tests/surcharges.test.ts -t "updateSurcharge clears rate"`, captured
before any Fix 1 code change — only the test was added):

```
 ❯ tests/surcharges.test.ts (7 tests | 1 failed | 6 skipped) 138ms
   × surcharges > updateSurcharge clears rate when a surcharge flips PERCENT to FLAT, and clears amount on the mirror flip 137ms
     → expected 0.04 to be null

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/surcharges.test.ts > surcharges > updateSurcharge clears rate when a surcharge flips PERCENT to FLAT, and clears amount on the mirror flip
AssertionError: expected 0.04 to be null

- Expected:
null

+ Received:
Decimal2 {
  "constructor": [Function Decimal2],
  "d": [ 400000 ],
  "e": -2,
  "s": 1,
}

 ❯ tests/surcharges.test.ts:79:26
     77|     const flipped = await prisma.surcharge.findUniqueOrThrow({ where: …
     78|     expect(flipped.kind).toBe("FLAT");
     79|     expect(flipped.rate).toBeNull();
       |                          ^

 Test Files  1 failed (1)
      Tests  1 failed | 6 skipped (7)
```

This is exactly the defect described: a PERCENT surcharge (`rate = 0.040000`) edited to FLAT via
the only payload superRefine allows (no `rate` key) persisted with `kind = FLAT, rate = 0.040000`
still on the row.

**GREEN** (`npx vitest run tests/surcharges.test.ts -t "updateSurcharge clears rate"`, after the
`toSurchargeRow` fix):

```
 ✓ tests/surcharges.test.ts (7 tests | 6 skipped) 163ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
```

### Fix 2 — `setCustomerSurcharge`'s create and update branches meant different things

**Change.** Added `toCustomerSurchargeRow(data: z.infer<typeof CUSTOMER_SURCHARGE>)`, the same
normalize-on-write shape as Fix 1 (`optOut: data.optOut ?? false, rate: data.rate ?? null, amount:
data.amount ?? null`). Both the create branch and the update branch now write this same
normalized row, so `setCustomerSurcharge(c, s, { optOut: true })` produces the identical row
(`optOut: true, rate: null, amount: null`) whether or not a prior override already existed.

**Test** (`tests/surcharges.test.ts`, `describe("setCustomerSurcharge")`,
`"fully replaces the override row on every call, regardless of which field arrives first"`) —
both orderings:

- Ordering A (rate first, then optOut, same customer): asserts the final row has `optOut: true,
  rate: null` — the old rate is not retained under the new field.
- Ordering B (optOut first, then rate, a fresh customer): asserts the final row has `optOut:
  false, rate: 0.05` — the identical final call converges to the same clean state regardless of
  history.

Both pass after the fix.

### Fix 3 — coverage on `updateSurcharge`, `listCustomerSurcharges`, and audit content

**Change.** No production code beyond Fixes 1/2/4/5. New/expanded tests:

- `describe("updateSurcharge")` — a scalar-and-glAccountId-clearing happy path, a 404-on-missing-id
  case, an unknown-`glAccountId` rejection, and the Fix 4 soft-deleted-row 404 (below).
- `describe("listCustomerSurcharges")` — lists a customer's overrides with `surchargeName`,
  `optOut`, `rate`, `amount`, and (M4) the position/id tiebreak ordering.
- `describe("setCustomerSurcharge")` — the Fix 2 both-orderings test, plus a dedicated test that
  exercises the update branch and reads the real audit diff:
  `"records the real before/after diff on the update branch"` asserts
  `entries.map(e => e.action)` is `["update", "create"]` (proving the update branch actually ran,
  closing the "only the create branch has ever run" gap) and asserts the actual `before`/`after`
  `optOut`/`rate` values on that update entry, not just that an entry exists.
- The step-code replace test (`"replaces the step-code list wholesale, recording the real
  before/after diff in one audit row"`) now also reads `readAudit("surcharge", id)` and asserts
  the real `before.stepCodes`/`after.stepCodes` `processStepCodeId` sets, per the house rule
  (assert audit content, not just "an entry exists").

Command: `npx vitest run tests/surcharges.test.ts` — all pass (full output under "Final GREEN"
below).

### Fix 4 — `updateSurcharge` mutated soft-deleted rows

**Change.** `updateSurcharge`'s write moved from `tx.surcharge.update({ where: { id }, data })` to
`tx.surcharge.update({ where: { id, deletedAt: null }, data: row })` — the newer precedent at
`process-step-codes.ts:309`, not the older one at `process-step-codes.ts:119` this function was
originally modeled on. No separate pre-check `findFirst`: the `deletedAt: null` filter is
evaluated as part of the `UPDATE` statement itself, so a concurrent soft delete resolves
atomically either way, and a stale tab on an already-deleted surcharge gets a P2025 that
`withDbErrors({ entity: "Surcharge" })` turns into `"Surcharge not found"` (404) — the same
message this function already produced for a genuinely nonexistent id, so a soft-deleted row is
reported exactly like a row that never existed rather than inventing a new failure class.

**Test** (`tests/surcharges.test.ts`, `describe("updateSurcharge")`,
`"404s against a soft-deleted surcharge instead of mutating it invisibly"`): creates a surcharge,
soft-deletes it, attempts an update, asserts a 404, asserts the row's `name` is unchanged, and
asserts no new audit entry was appended (audit count unchanged from right after the delete) — so
neither the scalar mutation nor a misleading "update after delete" history entry can occur.

Command: `npx vitest run tests/surcharges.test.ts -t "404s against a soft-deleted surcharge"` —
passes.

### Fix 5 — no way to remove a customer surcharge override

**Change.** Added `deleteCustomerSurcharge(customerId: string, surchargeId: string): Promise<void>`
beside its siblings: looks up the live `(customerId, surchargeId)` pair (`findFirst`, never
`findUnique`, the partial-unique rule), 404s (`"Customer surcharge override not found"`) if there
is none, otherwise soft-deletes it through `auditedSoftDelete("customerSurcharge", ..., undefined,
tx)` — never a hard delete. No `reason` parameter, matching the `deletePartPrice` /
`deleteCustomerContact` / `deleteCustomerAddress` precedent (small reference-like override rows
that don't carry the required-reason prompt other entities do). Not wrapped in Serializable — the
delete assigns no FK, and `auditedSoftDelete`'s own atomic `updateMany({ where: { id, deletedAt:
null } })` already closes the double-delete race without it.

**Tests** (`tests/surcharges.test.ts`, `describe("deleteCustomerSurcharge")`):

- `"soft-deletes the override, recording a delete audit entry"` — asserts `deletedAt` is set and
  the newest audit entry's `action` is `"delete"`.
- `"frees the surcharge to be deleted once the blocking override is removed"` — the fix's actual
  point, verified rather than assumed: creates a customer override, confirms `deleteSurcharge`
  is blocked (`"still in use"`), calls `deleteCustomerSurcharge`, then confirms `deleteSurcharge`
  now succeeds. This is the proof that `customerSurcharge`'s `REFERENCE_LINKS` entry's default
  `liveWhere: { deletedAt: null }` (no override in the registry entry) correctly excludes a
  soft-deleted row from `findBlockers`, rather than assuming it.
- `"404s when there is no live override for that customer/surcharge pair"` — covers both the
  never-existed case and the already-deleted case (a second delete of the same pair also 404s,
  not a silent no-op).

Command: `npx vitest run tests/surcharges.test.ts -t "deleteCustomerSurcharge"` — all 3 pass.

### Minors

- **M1** — added `expect(blockers[0].id).toBe(customer.id)` to the surcharge-delete-blocker test
  and `expect(blockers[0].id).toBe(id)` (the surcharge id) to the step-code-delete-blocker test.
- **M2** — added `"rejects a duplicate step code id in the same setSurchargeStepCodes call"`,
  asserting the `"Duplicate step code in the list"` message.
- **M3** — added a fourth case to the PERCENT/FLAT rejection test: `kind: "FLAT"` with both
  `amount` and `rate` set now asserts `"A flat surcharge cannot also carry a rate"`.
- **M4** — `listCustomerSurcharges`'s `orderBy` widened from `{ surcharge: { position: "asc" } }`
  to `[{ surcharge: { position: "asc" } }, { surcharge: { id: "asc" } }]`, mirroring
  `listSurcharges`'s own tiebreak. Covered by the new `listCustomerSurcharges` ordering test (two
  surcharges sharing `position: 1`, asserted to resolve in `id` order).
- **M5** — the step-code replace test now asserts the two-element intermediate state
  (`afterFirst[0].stepCodeIds`) before asserting the final single-element state, so the replace's
  `orderBy` and the fact that it's a genuine replace (not an append) are both exercised.

### Final verification

`npx vitest run tests/surcharges.test.ts tests/reference-links-sweep.test.ts`:

```
 ✓ tests/surcharges.test.ts (17 tests) 796ms
 ✓ tests/reference-links-sweep.test.ts (12 tests) 4ms

 Test Files  2 passed (2)
      Tests  29 passed (29)
```

`npx tsc --noEmit` — clean, no output.

`npx eslint src tests` — clean, no output.

`npm test` (`npx vitest run`), full suite:

```
 Test Files  100 passed (100)
      Tests  1464 passed (1464)
   Duration  138.92s
```

1464 = the prior 1453 plus the 11 net-new tests added in this fix wave (6 -> 17 in
`tests/surcharges.test.ts`). Zero regressions elsewhere.

### Files changed in this fix wave

- `src/server/surcharges.ts` — `toSurchargeRow`/`toCustomerSurchargeRow` normalize-on-write
  helpers (Fix 1, Fix 2); `updateSurcharge`'s `where: { id, deletedAt: null }` (Fix 4);
  `listCustomerSurcharges`'s tiebreak (M4); new `deleteCustomerSurcharge` export (Fix 5).
- `tests/surcharges.test.ts` — RED/GREEN test for Fix 1; both-orderings test for Fix 2; new
  `updateSurcharge`/`listCustomerSurcharges`/`deleteCustomerSurcharge` `describe` blocks (Fix 3,
  Fix 5); soft-deleted-row test (Fix 4); M1–M5 additions to existing tests.

No schema or migration change was needed for this fix wave — `CustomerSurcharge.deletedAt`
already existed (Task 2's migration), and `customerSurcharge`'s `REFERENCE_LINKS` entry already
defaults to `liveWhere: { deletedAt: null }` with no override needed.

No route change — Fix 5 is the service half only, per the task brief; the owner is amending the
plan to add the matching DELETE route to Task 8.
