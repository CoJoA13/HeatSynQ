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
