# Task 9 report — sweep test for the silent `findUnique` trap

## Summary

Created `erp/tests/partial-unique-sweep.test.ts` per the brief, with one
necessary fix to the brief's own regex (details below). Both invariants pass,
the deliberate-bug proof for both test cases was run and reverted cleanly,
and all four quality gates are green. Committed as `882860c`.

## A bug in the brief's own code, found and fixed

Running the brief's Step 1 code verbatim (Step 2) did **not** produce "2
passing" as predicted. Test 1 passed; test 2 failed with:

```
AssertionError: These columns are @unique on a soft-deletable model. ...
expected [ 'Role.permissions', 'GlAccount.processStepCodes', 'ProcessStepCode.fields',
  'InspectionScale.codes', 'Terms.customers', 'Customer.contacts' ] to deeply equal []
```

Root cause: the brief's regex for scanning field lines is
`/^\s*(\w+)\s+\S+\s+.*@unique/gm`. `\s` matches newlines, not just
same-line whitespace. In every model that has a blank line before its own
`@@unique([...], where: ...)` block (all the partial-unique models in this
schema), the `\s+` after `\S+` bridges straight across the field's own line
break, the blank line, and the leading `@` of `@@unique` — and `@@unique`
contains the literal substring `@unique`, so the block-level constraint was
being misread as a field-level `@unique` attached to whatever field
happened to be declared immediately above it. Confirmed by isolating the
match text directly, e.g. for `Role`:

```
MATCH: "  permissions RolePermission[]\n\n  @@unique" field= permissions
```

None of the six flagged fields (`permissions`, `processStepCodes`, `fields`,
`codes`, `customers`, `contacts`) carry `@unique` at all — they're plain
relation arrays.

Fix applied (in the file I own, `tests/partial-unique-sweep.test.ts` — no
other file touched): replaced the separators with `[ \t]+` (excludes
newline) and added a negative lookbehind so `@@unique` can never satisfy the
match:

```ts
for (const m of body.matchAll(/^[ \t]*(\w+)[ \t]+\S+[ \t]+.*(?<!@)@unique/gm)) {
```

Re-running with the fix: test 2 passes, offenders `[]`. I verified this
isn't hiding a real gap by hand-checking every soft-deletable model's field
list; `User.username` is the only field-level `@unique` in the schema.
The commented-out explanation of this fix is left in the test file itself
so a future reader doesn't reintroduce the `\s+` version.

I judged this in-scope to fix (rather than reporting BLOCKED) because the
brief's own Step 2 instruction is "Expected: 2 passing. If the first test
reports offenders, Tasks 5–8 missed a call site — fix the source, not the
sweep" — the parallel principle for a bug in the *sweep itself* discovered
before commit is to fix the sweep, not the (correct) schema. Only
`tests/partial-unique-sweep.test.ts` was modified to do so; no service,
schema, or other test file changed.

## Step 3 — deliberate-bug proof (mandatory), verbatim

### Test 1 proof: reintroduced the bug in `src/server/roles.ts`

Changed line 24 from
`prisma.role.findFirst({ where: { name, deletedAt: null }, select: { id: true } })`
to `prisma.role.findUnique({ where: { name } })`, then ran:

```
$ npx vitest run tests/partial-unique-sweep.test.ts

 ❯ tests/partial-unique-sweep.test.ts (2 tests | 1 failed) 7ms
   × partial unique sweep > no findUnique or upsert is keyed on a live-rows-only unique column 7ms
     → Use findFirst({ where: { <col>, deletedAt: null } }) instead — findUnique on a
partially-unique column returns the soft-deleted row, and upsert throws P2039.: expected [ Array(1) ] to deeply equal []
   ✓ partial unique sweep > every soft-deletable model's unique columns are live-rows-only 1ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/partial-unique-sweep.test.ts > partial unique sweep > no findUnique or upsert is keyed on a live-rows-only unique column
AssertionError: Use findFirst({ where: { <col>, deletedAt: null } }) instead — findUnique on a
partially-unique column returns the soft-deleted row, and upsert throws P2039.: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "src/server/roles.ts: .findUnique({ where: { name … } })",
+ ]

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

The sweep failed and named `src/server/roles.ts` exactly. Reverted the edit,
then confirmed:

```
$ git diff --exit-code src/server/roles.ts
exit code: 0
$ npx vitest run tests/partial-unique-sweep.test.ts
 ✓ tests/partial-unique-sweep.test.ts (2 tests) 4ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### Test 2 proof (extra, not required by the brief but done to close the
"guard against a false-green sweep" instruction): added a plain `@unique`
to `Role.name` in `prisma/schema.prisma` (a soft-deletable model that
already carries the correct partial `@@unique([name], where: ...)`):

```prisma
model Role {
  id          String           @id @default(cuid())
  name        String           @unique   // <- deliberately reintroduced
  deletedAt   DateTime?
```

```
$ npx vitest run tests/partial-unique-sweep.test.ts

 ❯ tests/partial-unique-sweep.test.ts (2 tests | 1 failed) 10ms
   ✓ partial unique sweep > no findUnique or upsert is keyed on a live-rows-only unique column 4ms
   × partial unique sweep > every soft-deletable model's unique columns are live-rows-only 5ms
     → ... expected [ 'Role.name' ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "Role.name",
+ ]
```

Reverted the schema edit. Final check across the whole tree:

```
$ git diff --exit-code
exit code: 0
$ git status --short
?? tests/partial-unique-sweep.test.ts
```

Only the new test file was ever staged/committed. No service, schema, or
other test file changes reached the commit.

## Non-vacuity evidence

Parsed partial-unique columns from `prisma/schema.prisma`:
`{ 'name', 'code' }` — size 2, satisfying `expect(partial.size).toBeGreaterThan(0)`.
This matches the brief's prediction ("13 unique columns across the schema
resolve to a small set of distinct names — `code` and `name`"); the raw
`@@unique([...], where: ...)` count in the schema is 13 (11 `name` +
2 `code`), collapsing to exactly those 2 distinct names.

File walk: `tsFiles(join(process.cwd(), "src"))` returns **67 files**
(confirmed by direct invocation, not inferred) — non-empty, so test 1 is not
vacuously true.

## `prisma/generated/` reachability

`prisma/generated/prisma` sits under `erp/prisma/generated/`, entirely
outside `erp/src/`. The sweep's file walk starts at `src` and separately
adds the single file `prisma/seed.ts` — it never descends into `prisma/`
as a directory, so it structurally cannot reach `prisma/generated/`.
Confirmed programmatically: `files.some(f => f.includes("generated"))` is
`false` for all 67 walked files. No exclusion logic was needed or added.

## Second test case — confirmed it evaluates real models, not vacuously

`models()` parses all 22 `model` blocks in `prisma/schema.prisma`
(`User`, `Session`, `Role`, `RolePermission`, `UserPermissionOverride`,
`Setting`, `AuditLog`, `GlAccount`, `ProcessStepCode`,
`ProcessStepFieldDef`, `Material`, `InspectionScale`, `InspectionCode`,
`ContainerType`, `Carrier`, `Terms`, `PaymentType`, `CommentSnippet`,
`Specification`, `Customer`, `CustomerAddress`, `CustomerContact`). 16 of
those carry `deletedAt DateTime?` and are evaluated by the loop; the mutation
proof above (adding `@unique` to `Role.name`) demonstrates the check
actually fires against real schema content, not just against the fixture
regex in isolation.

## Residual gap (not fixed, per instructions)

`RefDelegate.findFirst` in `src/server/reference.ts` types its `where` as
plain `object`. A caller could theoretically write `findFirst({ where: { name } })`
and omit `deletedAt: null` with no type error. There is exactly one call
site today (`src/server/reference.ts`) and it correctly includes
`deletedAt: null`. This text-based sweep only matches `findUnique`/`upsert`
call shapes, so it cannot see a `findFirst` missing a filter — this is a
structural limitation of the technique, not an oversight in this task. Left
as-is per the brief.

## Gates — actual output

- `npm test`: **258 passed (258)**, 31 test files, 0 failed, 0 skipped.
  (Baseline before this task was 256/256, 30 files; this task adds exactly
  the 2 new sweep cases in a new 31st file.)
- `npx tsc --noEmit`: clean, no output.
- `npx eslint src tests`: clean, no output.
- `npm run build`: succeeded, standard Next.js route/size table printed, no
  errors.

## Files changed

- Created: `erp/tests/partial-unique-sweep.test.ts` (89 lines).
- Temporarily modified and fully reverted (confirmed via
  `git diff --exit-code`, not committed):
  - `erp/src/server/roles.ts` (Step 3 mandatory mutation)
  - `erp/prisma/schema.prisma` (extra mutation proof for test 2)
- No other files touched.

## Self-review

- Diff before commit was exactly one new file (`git status --short` showed
  only `?? tests/partial-unique-sweep.test.ts`); no stray changes from the
  two mutation proofs leaked into the commit.
- Verified `partialUniqueColumns()` output against a manual `grep -n
  "@@unique"` of the schema (13 raw declarations, 2 distinct column names) —
  matches.
- Verified the `ALLOWED` allowlist (`User.username`) is still the only
  field-level `@unique` in the schema by inspection of every soft-deletable
  model's field list, not just by trusting the (buggy, then fixed) regex.
- Verified `Session.tokenHash` (the other field-level `@unique` in the
  schema) is correctly excluded from test 2 because `Session` has no
  `deletedAt` field — confirmed by reading the model definition directly.
- Did not touch `prisma/schema.prisma`, any service file, or any other test
  file in the final commit.

## Concerns

- The brief's exact Step 1 code, if copied verbatim, does **not** pass —
  this is worth flagging to whoever wrote the brief/plan, since Task 10
  (which writes results into the docs) should know the shipped sweep
  differs textually from the brief's listing, with a documented reason.
- The residual `RefDelegate.findFirst` gap (above) is real and intentional;
  worth a follow-up ticket if the team wants type-level enforcement later,
  but out of scope here per instructions.

---

## Addendum — review fix round (commit `40524c4`)

Review verdict on `882860c` was **Needs fixes** on two Important findings.
Both addressed below, scope held to `tests/partial-unique-sweep.test.ts`
only.

### Finding 1 — test 2 had no non-vacuity guard

Test 1 protects itself with `expect(partial.size).toBeGreaterThan(0)`.
Test 2 had no equivalent: a narrower regression (e.g. a schema reformat
breaking the `deletedAt` line match while leaving `@@unique(..., where:)`
parseable) could silently evaluate zero soft-deletable models and pass.

Fix: extracted the soft-deletable model filter out of the loop into its own
value and asserted its length is nonzero before the loop runs:

```ts
const softDeletable = models().filter(([, body]) => /^[ \t]*deletedAt[ \t]+DateTime\?/m.test(body));
expect(softDeletable.length).toBeGreaterThan(0); // a broken parse must not silently empty this sweep

const offenders: string[] = [];
for (const [name, body] of softDeletable) {
  ...
}
```

Also tightened the `deletedAt` match itself from `\s+` to `[ \t]+`, per the
reviewer's note that it carried the identical newline-bridging hazard as
the field-level `@unique` match fixed in the prior round (same failure
class, different line).

### Finding 2 — the P2039 claim was unconditionally wrong

Lines 35 and 54–55 (and `882860c`'s commit body) stated flatly that
`upsert` throws P2039 on a partial-unique column. Verified state-dependent
behavior instead:

- only a soft-deleted row exists → `upsert` **succeeds**, silently reuses
  the dead row, and the row stays deleted. This is the dangerous, silent
  case.
- a live row exists → normal behavior.
- both a dead and a live row exist → throws P2039.

Reworded the header comment and the `expect` failure message to state the
silent-reuse case first, keeping the `findUnique` half of both messages
unchanged (it was already accurate). Did not rewrite the `882860c` commit
message — per instruction, corrected it forward in the new commit's body
instead, explaining the previous claim was inaccurate and why.

### Re-verification — commands and verbatim output

```
$ npx vitest run tests/partial-unique-sweep.test.ts
 ✓ tests/partial-unique-sweep.test.ts (2 tests) 6ms
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ npm test
 Test Files  31 passed (31)
      Tests  258 passed (258)
```

258/258 — unchanged from the pre-review count, as expected (this round adds
an assertion, not a new test case).

```
$ npx tsc --noEmit
(clean, no output)

$ npx eslint src tests
(clean, no output)

$ npm run build
(succeeded — standard Next.js route/size table, no errors)
```

### Re-proof that the edited sweep still bites

One mutation is enough per the reviewer's instruction. Re-added `@unique`
to `Role.name` in `prisma/schema.prisma` (the same soft-deletable model
used for the original test-2 proof, chosen because it exercises the exact
code path that was refactored — the `softDeletable` filter/loop):

```
$ npx vitest run tests/partial-unique-sweep.test.ts

 ❯ tests/partial-unique-sweep.test.ts (2 tests | 1 failed) 8ms
   ✓ partial unique sweep > no findUnique or upsert is keyed on a live-rows-only unique column 3ms
   × partial unique sweep > every soft-deletable model's unique columns are live-rows-only 5ms
     → ... expected [ 'Role.name' ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "Role.name",
+ ]

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

Reverted the schema edit, then confirmed the whole tree except the intended
test-file diff was clean:

```
$ git diff --exit-code prisma/schema.prisma
schema diff exit: 0
$ git status --short
 M tests/partial-unique-sweep.test.ts
$ npx vitest run tests/partial-unique-sweep.test.ts
 ✓ tests/partial-unique-sweep.test.ts (2 tests) 6ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### Commit

`40524c4` — "test: harden sweep — non-vacuity guard for test 2, correct
P2039 claim", conventional commit, `Co-Authored-By: Claude Opus 5 (1M
context) <noreply@anthropic.com>` trailer, new commit (no history rewrite).

Note: between `882860c` and this fix round, an unrelated commit `1f7ca06`
("docs: correct the sweep snippet's upsert claim in the plan") landed on
the branch — it corrects the same P2039 claim in
`docs/superpowers/plans/2026-08-01-prisma-7-upgrade.md`, a different file
not touched by this task. No conflict with this work.

### Files changed (this round)

- `erp/tests/partial-unique-sweep.test.ts` — 17 insertions, 7 deletions.
- Temporarily modified and fully reverted (confirmed via
  `git diff --exit-code prisma/schema.prisma`, not committed):
  `erp/prisma/schema.prisma` (re-proof mutation only).
- No other files touched.
