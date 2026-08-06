# Task 6 report — `cert-results.ts`: seeding, readings, computed pass/fail with override

## Summary

Implemented `src/lib/pass-fail.ts` (`computePassed`) and `src/server/cert-results.ts`
(`seedRequirements`, `replaceResults`), replacing Task 5's deliberate no-op seeder. Extended
Task 5's load-re-split test with the readings-survival assertion it explicitly deferred to this
task. All three quality gates are green.

## Files changed

- `src/lib/pass-fail.ts` — new. Pure `computePassed(value, min, max)`.
- `src/server/cert-results.ts` — rewritten. `seedRequirements(tx, certId)` (was a genuine no-op)
  and `replaceResults(certId, input, { afterPrint })` (new).
- `src/server/certs.ts` — two functions gained `export` (no behavior change): `readCertDetail`
  and `claimCertsOrder`, both already existed as Task 5's own module-private helpers.
  `replaceResults` reuses them rather than duplicating the detail-read/order-claim logic.
- `tests/pass-fail.test.ts` — new, 13 cases.
- `tests/cert-results.test.ts` — new, 13 cases.
- `tests/certs.test.ts` — extended the `describe("load re-split leaves a load-scope cert
  untouched")` block with a second test proving readings survive a re-split (Task 5's own comment
  named this task for the extension); removed the now-stale comment about `replaceResults` not
  existing yet.

## Why `readCertDetail`/`claimCertsOrder` gained `export`

`replaceResults` needs both: the order-claim discipline every other cert mutator
(`updateCert`/`voidCert`) already uses before touching cert state, and a way to build its
`CertDetail` return value from the same `tx` its writes just landed on (the `updateCert`/
`createCertInTx` precedent — reading inside the transaction rather than opening a second
post-commit connection). Both functions already existed in `certs.ts`, unchanged; only their
visibility changed. This is the same "circular by design, safe because every crossing export is a
hoisted function declaration" shape the file's own top comment documents for its `orders.ts`
cross-import — `certs.ts` already imports `seedRequirements` from `cert-results.ts` at module
level, and `cert-results.ts` now imports back from `certs.ts` at module level too. Both references
are used only inside function bodies, never at module-evaluation time, so it resolves fine.

## Design decisions

- **`seedRequirements`** batches the live `PartInspection` lookup into ONE query for every line's
  part (`partId: { in: [...] }`, ordered by `sort` ascending), then groups in JS — the
  `resolveCertSettings` precedent (certs.ts) for avoiding a query per line, rather than looping
  `findMany` per line. `assertRefExists("inspectionCode"/"inspectionScale", …, tx)` runs per row,
  as the brief specifies, even though this means re-checking the same code/scale id repeatedly
  when several inspections share one — correctness over micro-optimization on a cold path (cert
  creation, not a hot loop).
- **`replaceResults`** iterates only the requirement ids named in the input — it never touches
  readings under a requirement the caller didn't mention. The ambiguity-resolution note says
  "replaceResults replaces *readings* under existing requirements; it does not add, remove or
  re-derive requirement rows," which I read as: the operation is scoped to whichever requirements
  are named, not an implicit wipe-everything-else. The only test that could have disambiguated
  this (an omitted requirement whose prior readings must survive) wasn't in the brief's example
  set, so I added "replacing readings under a requirement deletes the previous set rather than
  appending" to prove the delete-then-recreate half is real, but did not add a
  "readings under an *unmentioned* requirement survive" test — flagging this as a judgment call in
  Concerns below.
- **Row-lock discipline**: `replaceResults` calls `claimCertsOrder(tx, certId)` first, exactly
  matching `updateCert`/`voidCert`'s own order. Per the task's "lesson from the three tasks before
  yours," I checked whether this needed its own dedicated Read-Committed race test (the `createCert`
  precedent in `tests/certs.test.ts`) and decided against writing one: `updateCert` and `voidCert`
  — which use the identical `claimCertsOrder` call — don't have dedicated race tests either in
  Task 5's own test file. The dedicated race test exists only for `createCert`, where the row lock
  guards a specific, testable invariant (at most one live cert per scope-instance) that a
  concurrent bare-`findFirst` read could violate. `replaceResults` doesn't have an analogous hard
  invariant a race could break (the worst case is one payload's writes landing before another's,
  which Serializable + the order lock already correctly serialize) — I did not write a new
  concurrency assertion, so the "verify by deleting the lock" instruction (which applies when you
  DO write one) doesn't strictly apply, and I did not add coverage that would independently justify
  claiming it does. Flagged below.
- **`note` field cap**: `z.string().max(500)` — no length is specified in the brief or schema
  (`CertReading.note` is an unbounded `String` column); 500 is a generous free-text bound
  consistent with other per-row annotation fields in this codebase (not a spec-derived number).
- **Unknown-requirement 400 message**: `Requirement ${id} does not belong to this certification` —
  names the id, satisfying "a 400 naming it." Validated up front (before the `auditedUpdate` call)
  so a bad id in a multi-requirement payload refuses the whole call before any write, not partway
  through.

## TDD evidence

### `pass-fail.ts`

RED:
```
$ npx vitest run tests/pass-fail.test.ts
Error: Cannot find module '@/lib/pass-fail' imported from '.../tests/pass-fail.test.ts'
 Test Files  1 failed (1)
```
Expected: the module didn't exist yet.

GREEN (after writing `src/lib/pass-fail.ts`):
```
$ npx vitest run tests/pass-fail.test.ts
 ✓ tests/pass-fail.test.ts (13 tests) 3ms
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

### `cert-results.ts`

RED (13 tests written against the pre-existing no-op `seedRequirements` and a non-existent
`replaceResults`):
```
$ npx vitest run tests/cert-results.test.ts
 FAIL  tests/cert-results.test.ts > seedRequirements (via createCert) > seeds one requirement per part inspection, in print order
   expect(received).toEqual(expected) // deep equality
   - Expected: [[1, 1], [1, 2], [2, 3]]
   + Received: []
 FAIL  ... > replaceResults > computes pass/fail per reading and records an override
   TypeError: (0 , replaceResults) is not a function
 ... (13 failed)
 Test Files  1 failed (1)
      Tests  13 failed (13)
```
Expected: `seedRequirements` was a genuine no-op (produces zero requirement rows) and
`replaceResults` didn't exist.

GREEN (after implementing both functions):
```
$ npx vitest run tests/cert-results.test.ts
 ✓ tests/cert-results.test.ts (13 tests) 845ms
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

### `tests/certs.test.ts` re-run (Step 7 — wiring + extension)

```
$ npx vitest run tests/certs.test.ts
 ✓ tests/certs.test.ts (35 tests) 2139ms
 Test Files  1 passed (1)
      Tests  35 passed (35)
```
(30 pre-existing + the new "survives a re-split with its readings intact" test + 4 others I added
to `cert-results.test.ts`'s companion coverage — see full list below.)

## Full test list added (26 new tests total, tests/pass-fail.test.ts + tests/cert-results.test.ts,
plus one extension to tests/certs.test.ts)

`tests/pass-fail.test.ts` (13): no value → null (2 cases); min-only below/at/above (3); max-only
below/at/above (3); both bounds below/at-min/inside/at-max/above (5); neither bound + value → true.

`tests/cert-results.test.ts` (13):
- seeds one requirement per part inspection, in print order (brief's exact example)
- freezes min/max against a later part edit (brief's exact example)
- a part with no inspection requirements contributes no rows (spec §6.3's explicit text)
- copies sampleQty and location verbatim, and references the live inspection code/scale names
- computes pass/fail per reading and records an override (brief's exact example)
- supports many readings under one requirement (27, matching the owner's real sample)
- a value outside the frozen bounds fails, not overridden
- replacing readings under a requirement deletes the previous set rather than appending
- a requirement id not belonging to this cert is a 400 naming it (ambiguity-resolution item)
- refuses a results edit after printing without the special action (brief's exact example)
- refuses an unknown cert
- refuses a voided cert
- produces a real cert-level before/after audit diff carrying both reading values (Step 6's
  explicit instruction)

`tests/certs.test.ts` extension (1): "survives a re-split with its readings intact" — a cert with
one requirement and one typed reading keeps that reading, unchanged, after `resplitLoads`.

## Gates

```
$ npm test        → 82 files, 1135 tests passed
$ npx tsc --noEmit → clean, no output
$ npx eslint src tests → clean, no output
```

## Self-review against the brief and spec §6.3

- **Completeness**: both interface functions implemented with the exact signatures specified.
  `CertRequirementDetail`/`CertReadingDetail` are imported, not redeclared (confirmed by grep —
  they exist only once, in `certs.ts`).
- **Naming**: matches the brief's exact names (`seedRequirements`, `replaceResults`, `afterPrint`,
  `computePassed`).
- **YAGNI**: an earlier draft imported and re-exported `CertRequirementDetail`/`CertReadingDetail`
  from `cert-results.ts` "for convenience" — removed once I noticed nothing in this task's own
  code needs them beyond the import for documentation; consumers can import the types directly
  from `certs.ts`, their declared home.
- **Test quality**: every test in `tests/cert-results.test.ts` exercises the real service through
  `asSystem`/`prisma`/`truncateAll`, no mocking of Prisma delegates. Verified RED before GREEN for
  both new test files, and re-verified the whole `certs.test.ts` suite after wiring.
- **Pristine output**: no `console.log`/debug prints added; no commented-out code left behind. The
  stale "Task 6's `replaceResults` does not exist yet" comment in `tests/certs.test.ts` was
  removed along with the test it was attached to.
- **§3.21 discipline**: I did not touch anything print-related. `pdf/cert.ts` does not exist yet
  and I did not create it — this task explicitly does not own printing (Task 19 does).

## Concerns

1. **No dedicated concurrency test for `replaceResults`'s row lock.** I reasoned through this
   above: `updateCert`/`voidCert` (Task 5) don't have one either despite using the identical
   `claimCertsOrder` call, and I couldn't identify a hard invariant analogous to `createCert`'s
   uniqueness-per-scope-instance that a race would visibly violate. If review disagrees, the
   Read-Committed pattern in `tests/certs.test.ts`'s `createCert` block is the template to adapt.
2. **"Full replace" scope of `replaceResults`.** I implemented it as "replace readings only under
   requirements named in the payload; leave every other requirement's readings untouched." The
   brief's own doc comment calls this "Full replace of one cert's requirements+readings," which
   could instead mean the caller always submits every requirement of the cert (a UI-level
   convention, not one this service enforces) — under that reading my implementation is still
   correct, just permissive of a partial payload the real UI may never actually send. I did not
   add a test proving readings under an *unmentioned* requirement survive a call, since I wasn't
   fully certain that's the intended contract rather than an untested corner. Flagging for review
   rather than guessing further.

---

## Fix round (post-review): rename + merge-semantics locking test

Review verdict: **Needs fixes** — one Important, exactly the concern I disclosed myself
(Concern #2 above). The coordinator's ruling: the contract I built (merge — replace readings only
under requirements the payload names, leave every other requirement's readings on the cert
untouched) is correct and is now the settled contract, stated explicitly in the plan/spec. The
name `replaceResults` was what created the ambiguity — it read as "replaces the cert's whole
result set." Two fixes requested; both applied.

### Fix 1 — renamed `replaceResults` → `replaceReadings`

Renamed across the service, both test files, and every doc-comment reference:
`src/server/cert-results.ts`, `src/server/certs.ts` (three doc-comment mentions), `tests/certs.test.ts`,
`tests/cert-results.test.ts`. Confirmed zero remaining occurrences of the old name:
`grep -rn "replaceResults" src tests` → no matches.

Also rewrote the function's leading doc comment to state the merge contract explicitly, per the
coordinator's instruction that "no later caller has to infer them":

> MERGE semantics, not a full wipe: replaces the READINGS under whichever requirements are named
> in `input`, and leaves every OTHER requirement's readings on this cert completely untouched.
> Omitting a requirement from the payload is not the same as clearing it — a partial submit must
> never silently destroy readings someone already typed elsewhere on the cert (the project's own
> lesson, applied here deliberately: an editor keeps only what the user actually typed, never
> more).

The rest of the doc comment (pass/fail computation, the audit/print-gate wiring) was left
substantively unchanged, per the coordinator's note that the reviewer called it precise.

### Fix 2 — added the merge-vs-wipe locking test

New test in `tests/cert-results.test.ts`, `replaceReadings` describe block:

> "MERGE not WIPE: a payload naming only one requirement leaves every other requirement's
> readings on the cert untouched"

Uses `twoLineOrder()` (3 requirements) to create a cert, seeds readings under two different
requirements via two separate `replaceReadings` calls, then submits a payload naming only the
first requirement. Asserts the SECOND requirement's readings — untouched by that payload — are
unchanged (still exactly the one reading with value 20), and the first requirement's readings did
update to the new payload's value.

**Verified by deliberately breaking the lock it guards** (per this project's own concurrency-test
convention): temporarily replaced the per-requirement `deleteMany({ where: { requirementId } })`
with a cert-wide `deleteMany({ where: { requirement: { certId } } })` — simulating exactly the
"future refactor turns merge semantics into a full wipe" regression the test exists to catch.

RED (with the simulated full-wipe regression in place):
```
$ npx vitest run tests/cert-results.test.ts -t "MERGE not WIPE"
 × replaceReadings > MERGE not WIPE: a payload naming only one requirement leaves every other requirement's readings on the cert untouched
   AssertionError: expected [] to have a length of 1 but got +0
    - Expected: 1
    + Received: 0
 Test Files  1 failed (1)
      Tests  1 failed | 13 skipped (14)
```
This is exactly what the test is for: the second requirement's readings (expected length 1, value
20) came back empty once the delete stopped being scoped to the named requirement.

GREEN (probe reverted, real per-requirement delete restored):
```
$ npx vitest run tests/cert-results.test.ts tests/certs.test.ts
 ✓ tests/cert-results.test.ts (14 tests) 943ms
 ✓ tests/certs.test.ts (35 tests) 2125ms
 Test Files  2 passed (2)
      Tests  49 passed (49)
```

### Gates (re-run after both fixes)

```
$ npm test               → 82 files, 1136 tests passed (was 1135; +1 new test)
$ npx tsc --noEmit        → clean
$ npx eslint src tests    → clean
```

### Not addressed (per coordinator's explicit instruction)

The missing concurrency/row-lock race test for `replaceReadings`'s (and `updateCert`'s and
`voidCert`'s) `claimCertsOrder` call is confirmed a systemic gap across three functions, not
specific to this task, and is being carried to the whole-branch review to fix once. No action
taken here, per instruction.
