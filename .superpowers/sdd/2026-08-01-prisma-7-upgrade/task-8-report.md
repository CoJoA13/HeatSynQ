# Task 8 report — delete revival-on-create: process step codes

## Summary

Converted `createStepCode` in `erp/src/server/process-step-codes.ts` from a revive-or-create
ternary to an unconditional create, matching the shape already established in
`reference.ts::createReference` and `roles.ts::createRole`. Replaced the three revival tests in
`erp/tests/process-step-codes.test.ts` with one, strengthened per the task's "Judgment" guidance.
This is the last of the four revival sites (customers, roles, ten reference kinds, process step
codes) — all four are now converted.

## Files changed

- `erp/src/server/process-step-codes.ts`
- `erp/tests/process-step-codes.test.ts`

## TDD evidence

**Step 1 — wrote the new test, ran it against the unmodified service, watched it fail:**

```
$ npx vitest run tests/process-step-codes.test.ts -t "re-creating a deleted code"

 ❯ tests/process-step-codes.test.ts (17 tests | 1 failed | 16 skipped) 170ms
   × process step codes > re-creating a deleted code makes a NEW code with no inherited fields 169ms
     → expected 'cms9usw7k0002hdijloo3xjpk' not to be 'cms9usw7k0002hdijloo3xjpk' // Object.is equality
 ❯ tests/process-step-codes.test.ts:51:26
     49|
     50|     const { id: secondId } = await createStepCode({ code: "HT-01", nam…
     51|     expect(secondId).not.toBe(firstId);
       |                          ^

 Test Files  1 failed (1)
      Tests  1 failed | 16 skipped (17)
```

Failed exactly where predicted — `secondId` equalled `firstId` because the old service revived
the soft-deleted row instead of creating a new one.

**Step 2 — rewrote `createStepCode`, removed `REVIVAL_DEFAULTS`, re-ran the same test:**

```
$ npx vitest run tests/process-step-codes.test.ts -t "re-creating a deleted code"

 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp
 ✓ tests/process-step-codes.test.ts (17 tests) ...
```

(full run, all 17 tests in the file, shown below)

**Step 3 — full file:**

```
$ npx vitest run tests/process-step-codes.test.ts

 ✓ tests/process-step-codes.test.ts (17 tests) 1134ms

 Test Files  1 passed (1)
      Tests  17 passed (17)
```

## Inventory of every `findUnique`/`upsert` remaining in `src/server/process-step-codes.ts`

```
$ grep -n "findUnique\|upsert" src/server/process-step-codes.ts
62:  // findFirst, NOT findUnique: `code` is unique only among live rows, but the generated client
63:  // still types it unique, so findUnique would compile and return the soft-deleted row.
95:      const exists = await prisma.processStepCode.findUnique({ where: { id }, select: { id: true } });
```

One real `findUnique` call remains, and it is the only one in the file (the two other hits above
are comment text, not calls):

- **`src/server/process-step-codes.ts:95`**, inside `setStepFields` — `prisma.processStepCode.findUnique({ where: { id }, select: { id: true } })`. Keyed on **`id`**, the primary key, not `code`. Untouched, per the brief and Task 8's own instruction ("`findUnique({ where: { id } })` is correct — leave those alone").

No `upsert` calls exist anywhere in this file (there never were any — `upsert` was never used here; the brief's warning about `upsert`'s state-dependent unsafety is background context for the file overall, not a call that needed removing).

`createStepCode`'s duplicate check now uses `findFirst({ where: { code: data.code, deletedAt: null }, select: { id: true } })`, exactly mirroring `createReference` and `createRole`.

## Why the new test is non-trivial

The first code (`firstId`) is created with `glAccountId: gl.id` (a real GL account created via
`createReference("glAccount", { name: "4010" })`) and `equipmentTag: "F1"` — both are the schema
defaults' **opposite**: the default `glAccountId` is `null` and the default `equipmentTag` is
`""`. A field definition (`Soak`, `NUMBER`, `min`, sort 0) is attached via `setStepFields`.

Before deleting, the test reads the row back and asserts:

```ts
const firstRow = (await listStepCodes()).find((c) => c.id === firstId)!;
expect(firstRow).toMatchObject({ glAccountId: gl.id, equipmentTag: "F1" });
expect(firstRow.fields).toHaveLength(1);
```

This is the guard the task's "Judgment" section asked for: if the seeded values had silently
failed to apply (e.g. a typo in the create call, or `equipmentTag`/`glAccountId` being dropped by
a schema bug), the later "resets to default" assertions (`glAccountId: null, equipmentTag: ""`,
`fields: []`) would trivially pass for the wrong reason — the row never carried non-default
values to begin with, so "resetting" them would be a no-op indistinguishable from success. With
this pre-delete assertion in place, the test can only pass if the second, re-created row's
defaults are genuinely absent of the first row's real, verified-applied values — i.e. if the
service had kept carrying the predecessor's values forward (the old revival behavior), the test
would show `glAccountId: gl.id`, `equipmentTag: "F1"`, and `fields: [{ label: "Soak", ... }]` on
the *second* code instead of the defaults, and fail.

The `readAudit` assertion (`["create"]`, not `["create", "update"]` or similar) additionally
confirms the second code's history starts fresh under its own `entityId` — the exact defect
GitHub issue #10 was filed for (per `docs/HANDOFF.md` §5.18), and the comment text
("the defect issue #10 was filed for") is quoted verbatim from
`docs/superpowers/plans/2026-08-01-prisma-7-upgrade.md:1086`, which this brief's snippet was
generated from.

## Field-definition clearing transaction

Confirmed removed. `git diff` on `createStepCode` shows the entire
`existing ? auditedUpdate(...) : auditedCreate(...)` ternary — including the
`prisma.$transaction(async (tx) => { await tx.processStepFieldDef.deleteMany(...); return
tx.processStepCode.update(...); })` block — deleted outright, replaced by the unconditional
`auditedCreate(...)` branch alone. The two `$transaction` calls that remain in the file
(`setStepFields` and `updateStepCodeWithFields`) are unrelated — they replace a *live* code's own
field set, not a predecessor's.

The new test proves a re-created code has no inherited `ProcessStepFieldDef` rows directly:
`expect(fresh.fields).toEqual([])` after the first code was given one field via `setStepFields`
and confirmed present (`firstRow.fields` had length 1) before the delete.

## Deviations from the brief

1. **Strengthened the test's pre-delete assertions** (not in the brief's snippet verbatim). Added:
   ```ts
   const firstRow = (await listStepCodes()).find((c) => c.id === firstId)!;
   expect(firstRow).toMatchObject({ glAccountId: gl.id, equipmentTag: "F1" });
   expect(firstRow.fields).toHaveLength(1);
   ```
   Justification: the outer task brief's "Judgment" section explicitly asked for this
   ("consider asserting those actually applied before the delete, so the test cannot pass because
   the values never took"), citing Task 7's review finding of a trivially-passing "resets to
   default" test. The brief's own snippet already used non-default values (`gl.id`, `"F1"`), so
   the only gap was the missing pre-delete verification, which I added. No other test in the file
   covers this pre-delete state — it was newly introduced by this task's test — so this is
   additive, not a substitute for coverage found elsewhere.

2. **No other deviations.** The service rewrite (Step 3/4 of the brief) was applied verbatim: the
   `REVIVAL_DEFAULTS` constant and its comment were deleted exactly as specified (brief said
   lines 44–49; in the file as read, that constant/comment block was in fact at those line
   numbers), and the `createStepCode` body was replaced with the exact snippet the brief gave
   (confirmed by diff — no line differs from the brief's Step 4 code block except the added
   blank-line/comment formatting inherited from the file's existing style, which matches
   character-for-character with `createReference`/`createRole`'s equivalent comment).

## Test count evidence

Full suite, before this task (per task brief, unverified by me directly since I started
mid-branch): 258 passing / 0 skipped, across 30 files. My change nets -2 (three revival tests
collapsed into one): **256 passing / 0 skipped, across 30 files**, verified directly:

```
$ npm test
...
 Test Files  30 passed (30)
      Tests  256 passed (256)
   Start at  23:11:19
   Duration  27.12s
```

All 30 test files pass, nothing skipped. This matches the arithmetic (258 − 3 removed + 1 added =
256) exactly, so there is no unexplained discrepancy — I am reporting the observed number, 256,
rather than assuming 258 still held after consolidating three tests into one.

```
$ npx tsc --noEmit
(no output — clean)

$ npx eslint src tests
(no output — clean)

$ npm run build
 ✓ Compiled successfully in 1829ms
 ✓ Generating static pages (25/25)
(full route manifest printed, no errors)
```

All four gates green.

## Self-review findings

- Re-read the full rewritten `src/server/process-step-codes.ts` top to bottom after the edit.
  `updateStepCode`, `deleteStepCode`, `setStepFields`, and `updateStepCodeWithFields` are
  untouched — no unrelated validation was dropped. The `setStepFields` 404 guard
  (`findUnique({ where: { id } })` → `HttpError(404, ...)`) is intact, and its own test
  ("404s setStepFields against a nonexistent code instead of silently succeeding") still passes.
- Confirmed no import became unused: `updateStepCode` is still exercised by the surviving
  "clears the needsGlAccount flag once an account is attached" test; `auditedUpdate` is still
  used by `updateStepCode`, `setStepFields`, and `updateStepCodeWithFields`; `HttpError` is still
  used in `createStepCode`'s duplicate check and `setStepFields`'s 404.
- Kept the test at (now) line ~74, "still rejects a duplicate code when the existing row is not
  soft-deleted", byte-for-byte unchanged, per the outer task's explicit instruction — confirmed
  by diff (no hunk touches that test).
- Grepped the whole file for `findUnique`/`upsert` per the outer task's explicit requirement;
  inventory above accounts for the single remaining hit.

## Concerns

None. All four gates are green, the deviation is small and justified by the task's own guidance,
and the removed `$transaction` was verified gone by direct diff inspection, not just by tests
passing.
