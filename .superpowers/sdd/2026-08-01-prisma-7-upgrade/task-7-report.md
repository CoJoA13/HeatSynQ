# Task 7 Report — Delete revival-on-create: the ten reference kinds

Status: **DONE**. All four gates green, exactly the ten reference kinds covered through the one
generic delegate, no deviations from the brief that dropped any surviving guard, one deviation
that added coverage the brief's file list didn't spell out (Step 7's regression test's file
location).

Branch: `prisma-7-upgrade`, working from `/home/cojoa13/Desktop/HeatSynQ/erp`.

## TDD evidence

**Baseline**, before any edit in this task:

```
$ npm test
 Test Files  30 passed (30)
      Tests  254 passed | 1 skipped (255)
```

**RED** — after Step 1 (un-skip) and Step 2 (test rewrites), before touching `reference.ts`:

```
$ npx vitest run tests/reference-gl.test.ts tests/reference-tables.test.ts
 × GL account reference > re-creating a deleted name makes a NEW row carrying none of the predecessor
   → expected 'cms9u351q000hwzijdyx6dbn0' not to be 'cms9u351q000hwzijdyx6dbn0' // Object.is equality
    77|     const second = await createReference("glAccount", { name: "4010" });
    78|     expect(second.id).not.toBe(first.id);

 × reference delegate contract > permits a deleted row and a live row to share a name, but not two live rows
   → expected 'cms9u35hn001xwzijtbbnrx8s' not to be 'cms9u35hn001xwzijtbbnrx8s' // Object.is equality

 × flat reference tables > 'glAccount': a re-created name is a new row with default extras
 × flat reference tables > 'inspectionCode': a re-created name is a new row with default extras
 × flat reference tables > 'paymentType': a re-created name is a new row with default extras
 × flat reference tables > 'commentSnippet': a re-created name is a new row with default extras
 × flat reference tables > 'specification': a re-created name is a new row with default extras

 Test Files  2 failed (2)
      Tests  7 failed | 33 passed (40)
```

All 7 failures are on the predicted `expect(second.id).not.toBe(first.id)` line — the revival
branch was still returning the same id for every kind exercised, exactly as expected.

**GREEN** — after Steps 4–6 (`REVIVAL_EXTRA_DEFAULTS` deleted, `RefDelegate.findUnique` →
`findFirst`, `createReference` rewritten):

```
$ npx vitest run tests/reference-gl.test.ts tests/reference-tables.test.ts
 ✓ tests/reference-gl.test.ts (26 tests) 1412ms
 ✓ tests/reference-tables.test.ts (14 tests) 742ms
 Test Files  2 passed (2)
      Tests  40 passed (40)
```

## Task 4's un-skipped test

`tests/reference-gl.test.ts`'s `"permits a deleted row and a live row to share a name, but not two
live rows"` was `it.skip(`'d with the comment `// Revival-on-create is still in place until Task 7
removes it — un-skip there.` Changed to `it(`, comment deleted, confirmed passing above and in the
full suite run below. **Zero tests remain skipped** in the repo — confirmed by `npm test`'s
`Tests 258 passed (258)` (no `skipped` count at all).

## Step 7 — regression test, `reference.ts` untouched

Added to `tests/reference-gl.test.ts`'s "GL account reference" describe block (see "Deviation"
below for why that file/location rather than a line the brief didn't specify):

```ts
it("allows renaming a reference row onto a name only a deleted row still holds", async () => {
  const dead = await createReference("material", { name: "OLD" });
  await deleteReference("material", dead.id);
  const live = await createReference("material", { name: "KEEP" });

  await updateReference("material", live.id, { name: "OLD" });

  expect((await listReference("material")).find((r) => r.id === live.id)?.name).toBe("OLD");
});
```

```
$ npx vitest run tests/reference-gl.test.ts -t "onto a name only a deleted row"
 ✓ tests/reference-gl.test.ts (26 tests | 25 skipped) 154ms
 Test Files  1 passed (1)
      Tests  1 passed | 25 skipped (26)
```

**Passed without touching `reference.ts`.** I confirmed this by running it immediately after Step
2's test edits, *before* Steps 4–6's service change, and it already passed then too — it only
exercises `updateReference`, which was never part of the revival branch and needed no change. I
did not edit `updateReference` at any point in this task; `git diff -- src/server/reference.ts`
shows the only hunks are the deleted `REVIVAL_EXTRA_DEFAULTS` constant, the `RefDelegate` type, and
`createReference`'s body — `updateReference`'s and `deleteReference`'s bodies are byte-for-byte
unchanged.

## Inventory of every `findUnique`/`upsert` remaining in `src/server/reference.ts`

```
$ grep -n "findUnique\|upsert" src/server/reference.ts
33:  // findFirst, not findUnique: `name` is unique only among live rows, but the generated client
34:  // still types it unique — findUnique would compile and return the soft-deleted row.
72:  // (Task 4's partial index), hence findFirst filtered on deletedAt rather than findUnique, which
```

**Zero actual calls.** All three hits are comment text explaining why `findFirst` is used instead
— there is no live `findUnique` or `upsert` call anywhere in the file. `RefDelegate` itself no
longer declares a `findUnique` member (replaced by `findFirst` per Step 5), so the dangerous call
shape is unreachable through the shared delegate, not merely unused. `delegate(kind).update({
where: { id } })` is the only other lookup-by-key call remaining, and it is keyed on `id` (the
primary key, fully unique regardless of `deletedAt`) — correct to leave alone, per the brief.

I also grepped `paste.ts` (the only other file that calls into `reference.ts`) — it calls
`createReference(kind, input)` in a loop with no assumption about revival/same-id behavior, so it
needed no change and none was made.

## Per-kind coverage in the `it.each` rewrite

`tests/reference-tables.test.ts`'s `KINDS_WITH_EXTRAS` array, exactly as the brief specifies,
covers all five reference kinds that carry an extra column beyond name/active:

- `glAccount` (`description`)
- `inspectionCode` (`defaultScaleId`)
- `paymentType` (`glAccountId`)
- `commentSnippet` (`text`)
- `specification` (`text`)

Each runs the full re-create-after-delete cycle (`expect(second.id).not.toBe(first.id)` plus a
schema-default check on the extra field) via `it.each`, so it was not collapsed to a single kind.
Confirmed via the test run above: `flat reference tables > 'glAccount': a re-created name is a new
row with default extras`, `'inspectionCode': ...`, `'paymentType': ...`, `'commentSnippet': ...`,
`'specification': ...` — five distinct test entries, all passing.

One thing worth flagging honestly: for `inspectionCode` and `paymentType` the brief's own snippet
uses `extra: {}` (no non-default value set before delete), so those two entries' `field`
assertions are trivially true regardless of whether a stale value would have carried forward —
they mainly re-exercise the `not.toBe(first.id)` new-row check, not a "did the extra field survive
across the delete" check. `glAccount`, `commentSnippet`, and `specification` do set a non-default
extra (`"old"`) before delete, so those three genuinely prove the extra field resets. I kept the
brief's `extra: {}` values as given rather than inventing FK setup (a valid `inspectionScale.id`/
`glAccountId`) inside a static `as const` array, since (a) the brief specifies this literally, (b)
`REVIVAL_EXTRA_DEFAULTS`'s bespoke reset logic is gone entirely — a re-created row's extras are now
schema defaults by construction (Prisma's `create`, not a partial `update`), so there is no
kind-specific reset behavior left for this test to catch a regression in, and (c) this is new test
authorship, not a guard an existing surviving test depended on, so it isn't the kind of deviation
the brief's "Judgment" section is warning about preserving.

## Deviations from the brief

1. **Step 7's regression test's location wasn't specified by the brief's "Files" list** (which only
   names line numbers for Steps 1–2's edits). I added it to `tests/reference-gl.test.ts`'s "GL
   account reference" describe block, mirroring Task 5's precedent (added to `customers.test.ts`,
   alongside `createCustomer`/`updateCustomer`) and Task 6's (added to `roles.test.ts`, alongside
   `createRole`/`renameRole`) — the natural home is the file that already has `createReference`,
   `deleteReference`, `updateReference`, and `listReference` imported and exercised together. No
   surviving test's coverage was displaced by this addition.

2. **Comment added at `createReference`'s duplicate check** (not in the brief's abbreviated Step 6
   snippet, which shows only the code, no comment). I added a short explanatory comment mirroring
   the style already used in `roles.ts`'s `createRole` and `customers.ts`'s `createCustomer` (both
   explicitly named as "the shape this codebase settled on" for this task), since the file's
   convention documents *why* `findFirst` replaces `findUnique` at every such call site. This is
   additive documentation, not a change to logic or a dropped guard.

No guard, validation, or test coverage named in the brief or discovered as a surviving dependency
was dropped. `updateReference`'s pre-existing lack of a rename-time duplicate pre-check (relying on
`withDbErrors` mapping P2002 → 400) was left exactly as-is, per Step 7's explicit instruction — and
verified still correct by the new regression test plus the pre-existing `"rejects an unknown field
on update instead of silently dropping it"` and duplicate-account tests, all still passing.

## Files changed

- `/home/cojoa13/Desktop/HeatSynQ/erp/src/server/reference.ts`
  - Deleted `REVIVAL_EXTRA_DEFAULTS` and its explanatory comment block.
  - `RefDelegate` type: `findUnique` member replaced with `findFirst: (a: { where: object; select?:
    object }) => Promise<{ id: string } | null>`, with a comment explaining why (Step 5, verbatim
    shape from the brief).
  - `createReference`: duplicate-name lookup rewritten from `findUnique({ where: { name } })` to
    `findFirst({ where: { name, deletedAt: null }, select: { id: true } })`; the
    `existing ? auditedUpdate(...) : auditedCreate(...)` branch collapsed to an unconditional
    `auditedCreate(...)` (Step 6, verbatim shape from the brief, plus the added comment noted
    above).
  - `updateReference` and `deleteReference`: **byte-for-byte unchanged**.
  - The "compile-time delegate-shape check was tried and dropped" comment block (lines ~43–51):
    **preserved verbatim** — still accurate, unrelated to revival.
- `/home/cojoa13/Desktop/HeatSynQ/erp/tests/reference-gl.test.ts`
  - Un-skipped `"permits a deleted row and a live row to share a name, but not two live rows"`
    (Step 1), comment above it deleted.
  - Replaced `"revives a soft-deleted row when the same name is re-created"`, `"revival resets
    extra fields a genuine create would default, not just active"`, and `"revives a soft-deleted,
    previously-inactive row as active by default"` with the single brief-specified test
    `"re-creating a deleted name makes a NEW row carrying none of the predecessor"` (Step 2,
    verbatim).
  - Added the Step 7 regression test `"allows renaming a reference row onto a name only a deleted
    row still holds"` (verbatim from the brief; location decision explained above).
- `/home/cojoa13/Desktop/HeatSynQ/erp/tests/reference-tables.test.ts`
  - Deleted the now-unused `expectRevivalResetsExtraFields` helper (its only caller was the test
    being replaced; leaving it in would be dead code and would have failed
    `@typescript-eslint/no-unused-vars` / an unused-export lint rule).
  - Replaced `"revival resets extra fields for every kind that has one, not just active"` with the
    `KINDS_WITH_EXTRAS` constant and `it.each` rewrite (Step 2, verbatim from the brief).

`process-step-codes.ts` was not touched (Task 8's scope). `prisma/schema.prisma` was not touched,
no migration was created.

## Self-review findings

- No remaining reference to `REVIVAL_EXTRA_DEFAULTS`, "revival", "revive", or "Revived" anywhere in
  `src/server/reference.ts`, `tests/reference-gl.test.ts`, or `tests/reference-tables.test.ts`
  (grepped after edits). The only remaining hits repo-wide for those terms are in
  `src/server/process-step-codes.ts` / `tests/process-step-codes.test.ts` (Task 8's scope, not
  touched) and `tests/customers.test.ts` (Task 5's scope, already merged, not touched).
- `tests/paste.test.ts` — which calls `createReference` — has no `deleteReference` calls and makes
  no assumption about same-id revival, so it needed no change and had none.
- No new imports were required in either test file; `updateReference`, `readAudit`, and `prisma`
  were already imported in `reference-gl.test.ts` and are all still used.
- `RefDelegate`'s `findFirst` member is used at exactly one call site (`createReference`'s
  duplicate check); `findMany`, `create`, and `update` are each used at their existing single call
  sites — no dead delegate methods.

## Exact test counts observed

Baseline before this task: **254 passing / 1 skipped (255 total)**.

Final, after this task, all four gates:

```
$ npm test
 Test Files  30 passed (30)
      Tests  258 passed (258)

$ npx tsc --noEmit
(no output — clean, exit 0)

$ npx eslint src tests
(no output — clean, exit 0)

$ npm run build
✓ Compiled successfully in 1821ms
✓ Generating static pages (25/25)
```

**258 passing / 0 skipped (258 total)** — net +3 over baseline's 255 total (254 passing + 1
skipped). Traced to the two touched files only (every other file is unchanged, confirmed by
running just these two before and after): `tests/reference-gl.test.ts` held 27 entries before
(12 in "GL account reference" + 10 `it.each` kinds + 1 skipped + 4 routes) and 26 after (11 in "GL
account reference" — three revival tests replaced by two, the rewritten create test plus the new
Step 7 regression test — + 10 `it.each` + the un-skipped test, now passing + 4 routes), all
passing, 0 skipped. `tests/reference-tables.test.ts` held 10 entries before and 14 after (the
single combined revival test replaced by 5 `it.each` instances), all passing. Net: -1 entry in
`reference-gl.test.ts` (27→26, and its 1 skip becomes a pass) plus +4 entries in
`reference-tables.test.ts` (10→14) = +3 net test entries suite-wide, with the one skip converted
to a pass — exactly 255 + 3 = 258, all passing, 0 skipped, matching what `npm test` reports above.

## Concerns

None outstanding. The brief's predictions matched observed behavior exactly for this task — no
P2039-vs-silent-reuse mismatch surfaced here because Step 6's rewrite never calls `upsert`, and the
`findFirst`-then-`create` pattern (identical in shape to Tasks 5 and 6) sidesteps the trap
entirely rather than encountering it. All four gates are green; commit follows.

---

## Fix round — strengthening `inspectionCode`/`paymentType` coverage (post-review)

Review flagged, correctly, that `KINDS_WITH_EXTRAS`' `inspectionCode` and `paymentType` entries
used `extra: {}` — so the "first" row's `defaultScaleId`/`glAccountId` was already `null` (the
schema default) before the delete+re-create cycle, meaning the reset assertion
(`expect(...[field]).toBe(fresh)`) passed trivially whether or not `createReference` actually
reset anything. This is the exact weakness I disclosed in the original report; fault for the
`extra: {}` shape sits with the brief's own Step 2 snippet, but the coverage gap needed closing
regardless. Fixed. Scope: `tests/reference-tables.test.ts` only, `src/server/reference.ts`
untouched.

### The fix

`KINDS_WITH_EXTRAS`'s `extra` field became `setup`, an async callback run inside the test body
instead of a static literal in the table. For `glAccount`/`commentSnippet`/`specification` it just
returns the same `{ field: "old" }` literal as before, wrapped in `async () => (...)`. For
`inspectionCode`/`paymentType` it now creates a real `inspectionScale`/`glAccount` row first and
returns the FK pointing at it:

```ts
{
  kind: "inspectionCode",
  setup: async () => ({ defaultScaleId: (await createReference("inspectionScale", { name: "Brinell" })).id }),
  field: "defaultScaleId", fresh: null,
},
{
  kind: "paymentType",
  setup: async () => ({ glAccountId: (await createReference("glAccount", { name: "1010" })).id }),
  field: "glAccountId", fresh: null,
},
```

The test body now asserts the non-default value actually landed on the first row *before*
deleting it (so the test can't pass on a value that silently never applied), then proceeds exactly
as before:

```ts
async ({ kind, setup, field, fresh }) => {
  const extra = await setup();
  const first = await createReference(kind, { name: "X1", ...extra });

  const firstRow = (await listReference(kind)).find((r) => r.id === first.id);
  expect(firstRow?.[field]).not.toBe(fresh);

  await deleteReference(kind, first.id);
  const second = await createReference(kind, { name: "X1" });
  expect(second.id).not.toBe(first.id);
  const rows = await listReference(kind);
  expect(rows.find((r) => r.id === second.id)?.[field]).toBe(fresh);
}
```

Kept the `it.each` loop intact — did not unroll back to five hand-written tests — and did not drop
any kind from the table. `glAccount`, `commentSnippet`, and `specification` are functionally
unchanged (same literal values, same assertions, just reached through `setup()` for shape
consistency across all five entries).

### Covering test file

```
$ npx vitest run tests/reference-tables.test.ts
 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/reference-tables.test.ts (14 tests) 704ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
```

All 14 tests pass, including all 5 `it.each` entries (`glAccount`, `inspectionCode`, `paymentType`,
`commentSnippet`, `specification`) — same count as before the fix, count unchanged as expected
since this strengthens assertions rather than adding or removing test cases.

### Proof the strengthened assertion is non-trivial

Per instruction 5, I verified the new assertion would actually catch the bug it exists for, by
temporarily reintroducing a "carries the predecessor's columns forward" bug into
`src/server/reference.ts` (never committed — reverted via `git checkout HEAD --
src/server/reference.ts` immediately after observing the failure), then reverting:

```ts
// TEMP BUG SIMULATION — DO NOT COMMIT
const dead = await (prisma as unknown as Record<string, { findFirst: (a: object) => Promise<Record<string, unknown> | null> }>)[kind]
  .findFirst({ where: { name: data.name, NOT: { deletedAt: null } } });
const buggyMergedData = dead
  ? { ...dead, ...data, id: undefined, createdAt: undefined, updatedAt: undefined, deletedAt: undefined }
  : data;

const row = await auditedCreate(kind, data, () =>
  withDbErrors({ entity: REFERENCE_LABELS[kind].singular, conflictField: "name" }, () =>
    delegate(kind).create({ data: buggyMergedData })));
```

This simulates a regression where `createReference` still makes a genuinely new row (a fresh id,
so `second.id !== first.id` continues to hold) but spreads a soft-deleted predecessor's columns
into the new row's data — the narrow "new id, stale extras" failure mode the strengthened
assertion targets, as opposed to full revival (same id), which the `not.toBe(first.id)` check
already covers on its own.

```
$ npx vitest run tests/reference-tables.test.ts
 × flat reference tables > 'glAccount': a re-created name is a new row with default extras
   → expected 'old' to be '' // Object.is equality
 × flat reference tables > 'inspectionCode': a re-created name is a new row with default extras
   → expected 'cms9uj67i001l2cij22u12bxu' to be null // Object.is equality
 × flat reference tables > 'paymentType': a re-created name is a new row with default extras
   → expected 'cms9uj68p001s2cij9vdh5qce' to be null // Object.is equality
 × flat reference tables > 'commentSnippet': a re-created name is a new row with default extras
   → expected 'old' to be '' // Object.is equality
 × flat reference tables > 'specification': a re-created name is a new row with default extras
   → expected 'old' to be '' // Object.is equality

 Test Files  1 failed (1)
      Tests  5 failed | 9 passed (14)
```

All 5 `it.each` entries fail under the simulated bug, critically including `inspectionCode` and
`paymentType` — which is the point: under the **old** `extra: {}` version, this exact bug would
have been invisible for those two kinds, because the predecessor's `defaultScaleId`/`glAccountId`
was already `null` (the same value `fresh` expects), so a stale carry-forward of `null` is
indistinguishable from a correct reset. With `setup()` seeding a real non-null FK first, the
carried-forward value (`"cms9uj67i..."`, the dead scale's id / `"cms9uj68p..."`, the dead GL
account's id) is now visibly different from `fresh` (`null`), so the bug surfaces.

Reverted immediately after capturing this output:

```
$ git checkout HEAD -- src/server/reference.ts
$ git diff --stat
 erp/tests/reference-tables.test.ts | 31 +++++++++++++++++++++++++------
 1 file changed, 25 insertions(+), 6 deletions(-)
```

— confirming only the test file carries a diff; `reference.ts` is back to exactly the committed
state (`91fdcaf`), verified both by `git diff --stat` showing zero hunks there and by re-running
`tests/reference-tables.test.ts` immediately after, which returned to 14/14 passing.

### All four gates, post-fix

```
$ npm test
 Test Files  30 passed (30)
      Tests  258 passed (258)

$ npx tsc --noEmit
(no output — clean, exit 0)

$ npx eslint src tests
(no output — clean, exit 0)

$ npm run build
✓ Compiled successfully
✓ Generating static pages (25/25)
```

**258 passing / 0 skipped** — identical to the pre-fix count, exactly as expected: this round
strengthens two assertions, it does not add or remove test cases.

### Commit

`b7e69f5` — "test: give inspectionCode and paymentType a real non-default extra to reset from"

Scope: `tests/reference-tables.test.ts` only, as instructed. `src/server/reference.ts` was not
modified in this fix round (the temporary bug simulation above was written, exercised, and
reverted without ever being staged or committed — confirmed via `git diff --stat` and `git status`
before committing).
