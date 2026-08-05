# Task 5 report — `certs.ts`: scope-aware creation, uniqueness under the claim, void

Commit: `49450d3` — `feat(certs): scope-aware creation, listing, export and void`

## What was implemented

`src/server/certs.ts` gained the full cert-record surface on top of Task 4's `resolveCertSettings`:

- **`createCert(input, tx?)`** — zod-validates the input, enforces the per-scope shape (`LOAD`
  requires `loadNumber` and no `shipperId`; `SHIPMENT` requires `shipperId` and no `loadNumber`;
  `ORDER` carries neither) with field-anchored 400s, then runs `createCertInTx`:
  `claimOrder(tx, orderId)` (404 if missing or voided) → the service-enforced uniqueness check
  (`findFirst` scoped to `{ orderId, scope, loadNumber, shipperId, deletedAt: null }`, 400 on a
  clash) → `auditedCreate("cert", …, { tx })` → `seedRequirements(tx, cert.id)` (Task 6's no-op) →
  `readCertDetail`. When `tx` is passed (Task 8's future call), it runs directly inside the
  caller's own transaction with no extra `withDbErrors`/`$transaction` wrapping; when omitted, it
  opens its own `withDbErrors` → Serializable `$transaction`.
- **`getCert(id)`** — full `CertDetail` (requirements/readings included), deliberately not
  filtered on `deletedAt` (a voided cert stays readable, the `readDetail`/voided-order precedent).
- **`listCerts(filter)`** — `customerId`/`scope`/`printed`/`includeVoided`/`search` filters,
  newest-first (`createdAt desc`, `id desc` tiebreak), `readingCount`/`failCount` computed from a
  minimal projection (`requirements: { select: { readings: { select: { passed: true } } } }`)
  rather than building a full `CertDetail` per row.
- **`exportCerts(filter)`** — reuses `listCerts` + `excel.ts`'s `toXlsx`, exactly like
  `exportOrders`.
- **`updateCert(id, input)`** — `freeform`/`internalNotes` only, via `auditedUpdate`.
- **`voidCert(id, reason)`** — reason trimmed and required **in the service** (not just a future
  route), `auditedSoftDelete`.
- **`certsForOrder(orderId)`** — every cert for one order, voided included (the order hub's own
  "by load · 4 loads · 0 certs" view needs to see a voided cert, not have it vanish).
- **`CertRow`/`CertDetail`/`CertFilter`/`CertRequirementDetail`/`CertReadingDetail`** — declared
  exactly as the brief's Produces block specifies.

`orders.ts`'s `saveNewOrder` now calls `createCert({ orderId: order.id, scope: "ORDER" }, tx)`
inside its own transaction, right after `createSerials`, guarded on
`certResolution.certRequired && certResolution.certScope === "ORDER"`. `LOAD` and `SHIPMENT` create
nothing at save time (on-demand / Task 8, respectively).

`src/server/cert-results.ts` is new: `seedRequirements(tx, certId)` is a genuine no-op (`void tx;
void certId;`, nothing read or written) with a comment naming Task 6 as the owner and spelling out
spec §6.3's contract for what it should eventually do. `certs.ts` imports the function from it;
`cert-results.ts` does not import anything from `certs.ts` yet (Task 6 will, via `import type`).

### Design decisions beyond the brief's literal text

- **`updateCert` and `voidCert` also claim the cert's owning order** (`claimCertsOrder`: a bare,
  unlocked read of the cert's immutable `orderId`, then `claimOrder(tx, orderId)`, then a locked
  re-read of the cert's own mutable state) before acting. The brief's Step 4 only spells this out
  for `createCert`, but spec §5.3 says it for every cert mutation ("claims every affected order row
  with `claimOrder` before reading the state it acts on"), and CLAUDE.md is explicit that row locks,
  not isolation levels, are what make a cross-transaction invariant safe — two transactions voiding
  and creating against the same scope-instance need a shared lock to serialize correctly at any
  isolation level, not just Serializable's own conflict detection. I read this as required, not
  optional, and implemented it for both mutators.
- **A `SHIPMENT`-scope test path** using raw `prisma.shipper.create`/`prisma.shipperOrder.create`
  fixtures (Task 8's `shippers.ts` doesn't exist yet) to exercise the `shipperNumber`/`sequence`
  join logic the brief's own five tests never touch. Without it, `sequenceMap` and the
  `shipperNumber` select would have shipped completely untested.
- **`material` on `CertDetail`** is the LEAD line's part's material name (or `""`), confirmed
  against spec §10.3's printed layout ("`Material` (the lead part's material)") rather than
  guessed.
- **`Cert.shipperId` is not `assertRefExists`-guarded.** Spec §7's `REFERENCE_LINKS` additions list
  only `shipper.carrierId`, `certRequirement.inspectionCodeId` and `certRequirement.scaleId` — not
  `cert.shipperId` — so an invalid id falls through to the ordinary P2003 → "That shipper does not
  exist" translation in `withDbErrors` rather than a bespoke check. Untested in this task (Task 8
  is the only caller that will ever pass a `shipperId`, and it will always be a shipper it just
  created).

## Tests

`tests/certs.test.ts`, 31 cases, all against the real `erp_test` DB (`beforeEach(truncateAll)`).
Covers: the brief's five Step-1 tests verbatim, the Step 5 order-save test verbatim, the Step 6
load-re-split test adapted per the stated ambiguity resolution (asserts `deletedAt === null` and
`loadNumber` unchanged; a comment names Task 6 as the one to add the readings assertion once
`replaceResults` exists), plus: per-scope shape validation (6 cases), an unknown-order 404, a
SHIPMENT-scope independence/sequence/shipperNumber case, create/update/void audit-content
assertions (Step 7), `getCert` (defaults, voided-still-readable, 404), `updateCert` (patch + 404),
`voidCert` (empty/whitespace reason, already-voided 404, unknown 404), `listCerts`
(includeVoided, scope/customerId/printed filters, newest-first ordering, search across order
number/PO/customer code/name), `exportCerts` (header row + cell values), and `certsForOrder`
(voided included, scoped to the right order).

### TDD evidence

**RED.** After writing the full test file against the (at-that-point-complete) implementation, I
verified genuine RED by stashing `src/server/certs.ts` + `src/server/orders.ts` and removing
`src/server/cert-results.ts`, then running:

```
npx vitest run tests/certs.test.ts
```

Result: **31 failed / 31 total**, all `TypeError: (0 , createCert) is not a function` (and the
equivalent for `getCert`/`listCerts`/`exportCerts`/`updateCert`/`voidCert`/`certsForOrder`) — the
expected failure mode for calling functions that don't exist yet:

```
 FAIL  tests/certs.test.ts > listCerts > filters by scope, customerId and printed
TypeError: (0 , createCert) is not a function
...
 Test Files  1 failed (1)
      Tests  31 failed (31)
```

**GREEN.** Restored the implementation (`git stash pop` + restored `cert-results.ts`) and reran:

```
npx vitest run tests/certs.test.ts
```

Result: **31 passed / 31 total**.

```
 ✓ tests/certs.test.ts (31 tests) 1611ms
 Test Files  1 passed (1)
      Tests  31 passed (31)
```

One genuine implementation-vs-test bug surfaced and was fixed during GREEN iteration: my
`exportCerts` column-index assertions in the export test were off by one (I forgot `Seq` shifts
every later column right by one against my first draft's mental model) — fixed by recounting the
column list against `CERT_COLUMNS` and rerunning.

### Full gate run (after the fix)

```
npm test            → 80 test files, 1105 tests, all passed
npx tsc --noEmit     → clean
npx eslint src tests → clean
npm run build        → succeeded
```

`tests/orders.test.ts` (125), `tests/cert-resolution.test.ts` (6), `tests/certs-schema.test.ts`
(13) and `tests/order-loads.test.ts` (29) were run individually first (files this task's changes
touch or depend on) before the full suite — all green.

## Files changed

- `erp/src/server/certs.ts` — modified (Task 4's `resolveCertSettings` untouched; ~400 new lines
  below it).
- `erp/src/server/orders.ts` — modified (one new import, one 8-line block in `saveNewOrder`).
- `erp/src/server/cert-results.ts` — new (`seedRequirements` no-op stub).
- `erp/tests/certs.test.ts` — new (31 tests).

## Self-review

**Completeness against the brief.** All eight Produces-block exports present with the exact names
and shapes given (`CertRow`, `CertDetail`, `CertFilter`, `CertReadingDetail`,
`CertRequirementDetail`, `createCert`, `getCert`, `listCerts`, `exportCerts`, `updateCert`,
`voidCert`, `certsForOrder`). All eight brief steps done: failing tests written and verified
failing (Step 2), `createCert` implemented per Step 3's exact algorithm including the literal
uniqueness-check snippet, Step 4's five remaining functions implemented, Step 5's order-save hook
and its verbatim test, Step 6's adapted re-split test with the required comment naming Task 6,
Step 7's audit-content assertions, Step 8's gates + commit.

**Spec compliance.** §4.1 (service-enforced uniqueness under the claim, no `certNumber`, no
`@@unique` added to `Cert`), §5.6 (void mirrors the order/shipper shape, reason required in the
service, stored documents unaffected — no document-store code exists yet to even touch), §6.2
(scope-timing table: ORDER at save, LOAD on-demand only, SHIPMENT is Task 8's — verified by the
Step 5 test and by grep: `createCert` is called from exactly one place in `orders.ts` and nowhere
in `order-loads.ts`).

**Naming.** Matches the codebase's existing vocabulary throughout (`claimOrder`, `auditedCreate`/
`auditedUpdate`/`auditedSoftDelete`, `withDbErrors`, `HttpError`, the `Db` type alias, the
`readDetail`/`toDetail` split mirrored as `readCertDetail`/`toCertDetail`).

**YAGNI.** Did not build any part of Task 6's seeding logic, Task 8's shipment creation, or any
route/permission-gate code (out of this task's file list). Did not add `assertRefExists` for
`cert.shipperId` since it isn't a registered reference kind and no test needs it. Did not wire up
`cert_number_next` anywhere.

**Test quality.** Beyond the brief's five literal tests, added coverage for every branch
`assertScopeShape` can take, the SHIPMENT-scope path (untouched by the brief's own tests),
audit-content assertions for create/update/void (Step 7's explicit ask), and full coverage of
`listCerts`/`exportCerts`/`certsForOrder`/`getCert`/`updateCert` since the brief's Step 1 test list
only covers `createCert`/`voidCert`.

**Pristine output.** `tsc`, `eslint`, and the full `npm test` run all clean with no warnings.

## Concerns

- **`updateCert`/`voidCert` claiming the order** is a defensible reading of spec §5.3 rather than
  something the brief spells out in Step 4's prose. If a later reviewer disagrees with extending
  the claim beyond `createCert`, the fix is small (drop `claimCertsOrder`'s `claimOrder` call and
  fall back to a bare `findFirst`), but I believe the stronger reading is correct and matches how
  `voidOrder`/`updateOrder` already claim the order they mutate.
- **The circular import** (`orders.ts` → `certs.ts` for `createCert`, `certs.ts` → `orders.ts` for
  `claimOrder`) is real at the module-graph level, though only ever exercised inside function
  bodies (never at module-evaluation time), and `tsc`/`eslint`/the full test suite/`next build` all
  pass clean with it in place. Flagging it explicitly since it's a structural choice the brief's own
  Step 3/Step 5 instructions require, not an accident.
- **`Cert.shipperId` has no `assertRefExists` guard** — an invalid id falls through to the generic
  P2003 → "That shipper does not exist" translation rather than a purpose-built check. This matches
  spec §7's `REFERENCE_LINKS` list (which does not include `cert.shipperId`), but is worth a second
  look once Task 8 exists and can exercise the real caller.

## Review response (round 2)

Reviewer verdict: **Approved**, with two items to close before merge — a missing concurrency proof
for the per-scope uniqueness invariant, and a missing symmetric voided-cert test on `updateCert`.
Both addressed. The circular-import observation was carried forward for Task 7 (extracting
`claimOrder` into a new `src/server/order-locks.ts`), not touched here per the coordinator's
explicit instruction.

### `updateCert` voided-cert coverage

Added `updateCert > refuses to update a voided cert` (`tests/certs.test.ts`), symmetric to
`voidCert`'s existing "refuses to void an already-voided cert": creates a cert, voids it, asserts
`updateCert` 404s. Matches `updateOrder`'s own precedent for a voided order.

### The uniqueness invariant's concurrency proof

This took two iterations to get right, and the process surfaced a real subtlety worth recording.

**First attempt** — a true, uncontrolled race (`Promise.allSettled` on two `createCert` calls, no
synchronization, the `createOrder`/`clientRequestId` precedent from tests/orders.test.ts:432).
Asserted the loser got exactly a 409. This passed in isolation but **failed in ~8 of 10 runs** once
run after this file's own earlier tests had warmed up the connection pool — the loser's status
flipped to a clean 400 instead. Root cause: unlike `createOrder`'s conflict (a hard unique-index
violation on `clientRequestId`, which Postgres resolves as a P2002 deterministically regardless of
timing), this invariant has no index behind it (spec §4.1 — that's the whole reason the check has
to run under `claimOrder`'s lock in the first place). Whether the loser's own Serializable snapshot
happens to already reflect the winner's commit (→ a clean business-rule 400) or not (→ Postgres's
SSI catching the resulting write-skew, a 40001 mapped to 409) is genuinely timing-dependent, not a
bug — both are "correctly refused, no duplicate committed." Pinning the assertion to one specific
status code was the actual defect, not the underlying code.

**Second attempt** — followed the `claimOrder` row-lock precedent instead (order-loads.test.ts
"blocks on a concurrent claim of the order row until it releases"; part-process-steps.test.ts
"lockCurrentRevision cannot lock a revision that loses its last step while the claim is held"): a
manual holder takes the exact `SELECT … FOR UPDATE` `claimOrder` takes, proven blocking via a
race-against-timeout, then commits a cert while still holding the lock. The first version of this
(holder just inserts, no read first) **also failed 100% of the time** — but with `createCall`
*resolving successfully*, i.e. actually committing a second, duplicate cert. Diagnosed by reasoning
through Postgres's SSI (Serializable Snapshot Isolation): a genuine anomaly requires a *cycle* of
read-write conflicts between the two transactions, not just one. The holder's bare `INSERT` created
only one edge (its write, unseen by `createCall`'s already-fixed snapshot); with no matching read on
the holder's side landing in `createCall`'s eventual write's predicate, there was no cycle for SSI
to detect, and nothing aborted anything. Fixed by having the holder run the exact same clash-check
`SELECT` `createCertInTx` itself runs before its own `INSERT` — mirroring both of `createCert`'s
statements, not just its final write — which closes the cycle and makes SSI's protection apply.
Also had to make the holder's own transaction explicitly Serializable (it defaulted to Read
Committed, Prisma's default): SSI's guarantee only holds between transactions that are *both*
Serializable, so a non-Serializable holder let `createCall` read straight past the whole scenario
with no conflict ever registered.

The final test (`blocks a concurrent create for the same scope-instance until the holder's cert
commits, then refuses instead of duplicating (row-lock discipline)`) asserts the loser gets *either*
a clean 400 or a 409 (both are legal — see above) but never resolves, plus `prisma.cert.count(...)`
is exactly 1. Kept the relaxed true-race test alongside it (`two genuinely concurrent creates...`)
as a supplementary, real-world-shaped confirmation with the same relaxed assertion — no manual
synchronization at all, closer to what an actual double-click race looks like.

**Stability.** Both new tests were stress-run 15–20 times each, both filtered in isolation and as
part of the full `tests/certs.test.ts` file (the context that reproduced the original flake), with
zero failures after the fix. Before the fix, the file failed 8/10 and then 15/15 times respectively
in the exact same harness, so this was a meaningful, reproducible verification, not a hopeful
guess.

### Re-run gates

```
npx vitest run tests/certs.test.ts   → 34 tests, all passed (run 15x back-to-back, no flakes)
npm test                              → 80 test files, 1108 tests, all passed
npx tsc --noEmit                      → clean
npx eslint src tests                  → clean
```

### Files changed (round 2)

- `erp/tests/certs.test.ts` — three new tests: the deterministic row-lock concurrency proof, the
  supplementary true-race confirmation, and `updateCert`'s voided-cert 404 case. No production code
  changed.

## Review response (round 3)

Reviewer verdict on round 2: `updateCert`'s voided-cert test closed and correct. The concurrency
test did not — diagnosed as a **specific, reproducible defect**, not vague flakiness: the reviewer
swapped `claimOrder(tx, data.orderId)` in `createCertInTx` for a bare `tx.order.findFirst(...)`,
changed nothing else, and both of round 2's concurrency tests stayed green across five runs. Root
cause given: both my round-2 tests ran the competing caller under Serializable, matching every real
caller of `createCertInTx`. With BOTH sides Serializable and both doing the identical clash-check
`SELECT` then `INSERT` on `Cert`, Postgres's own SSI (Serializable Snapshot Isolation) detects the
write-skew on that predicate by itself — the `Order` row lock never had to do anything, so removing
it changed nothing observable. My round-2 report even recorded discovering the SSI-cycle mechanic
directly, without recognizing what it implied: if closing the cycle is what makes the test pass,
then the row lock isn't what's under test — SSI is.

### The fix

CLAUDE.md's actual point ("the row lock works at ANY caller isolation") is what makes a row lock
the guarantee rather than the isolation level, and it applies here in the other direction: to make
`claimOrder` provably load-bearing, the COMPETING caller has to run at an isolation level where SSI
provides no independent protection. The `lockCurrentRevision` precedent
(`tests/part-process-steps.test.ts`) already does exactly this — it calls the exported function
directly against a manually-opened, default-isolation (Read Committed) `tx`, bypassing whatever
isolation level its production callers normally wrap it in.

`createCert(input, tx?)`'s own signature supports the identical move: when `tx` is passed, it never
opens its own transaction. So the new test calls
`prisma.$transaction((tx) => createCert({ orderId: order.id, scope: "ORDER" }, tx))` with **no**
`isolationLevel` — Read Committed, Prisma's default — instead of the public no-`tx` form (which
always forces Serializable). Under Read Committed there is no whole-transaction snapshot and no SSI
at all: every statement gets a fresh look at the database, so the *only* thing that can serialize
this call against a concurrent holder of the Order row is `claimOrder`'s row lock itself. That also
makes the outcome fully deterministic — always exactly the same clean 400, never round 2's legal
400-or-409 ambiguity — because SSI has nothing to do with this path.

Replaced round 2's holder-based test with this Read-Committed version (retitled to match: "blocks a
concurrent create under Read Committed until the holder's cert commits, then refuses on the fresh
read (row-lock discipline)"). Simplified the holder back to its minimal shape (drop the clash-check
read I'd added in round 2 — it was only ever needed to close the SSI cycle, which no longer applies
here since `createCall` isn't Serializable).

Kept the relaxed "two genuinely concurrent creates" test (both sides Serializable, through the
public API, no manual synchronization), but retitled and re-commented it honestly per the round-2
diagnosis: it does **not** regression-guard the row lock — Postgres's own SSI protects that specific
scenario independently, as the reviewer's own experiment proved — and the comment says so plainly,
pointing at the Read-Committed test as the actual row-lock proof. It stays because it is still true
and still worth knowing that two real double-submits through the production API can't duplicate a
cert; it is not being presented as coverage it doesn't provide.

### RED/GREEN regression evidence (verified by hand, per the coordinator's bar)

**Applied the exact regression** the reviewer used — `src/server/certs.ts`, `createCertInTx`:

```diff
-  const order = await claimOrder(tx, data.orderId);
+  const order = await tx.order.findFirst({ where: { id: data.orderId } });
```

**RED** — `npx vitest run tests/certs.test.ts -t "blocks a concurrent create under Read Committed"`:

```
 ❯ tests/certs.test.ts (34 tests | 1 failed | 33 skipped) 387ms
   × createCert > blocks a concurrent create under Read Committed until the holder's cert commits, then refuses on the fresh read (row-lock discipline) 387ms
     → promise resolved "{ …(20) }" instead of rejecting

 FAIL  tests/certs.test.ts > createCert > blocks a concurrent create under Read Committed until the holder's cert commits, then refuses on the fresh read (row-lock discipline)
AssertionError: promise resolved "{ …(20) }" instead of rejecting

- Expected
+ Received

- Error {
-   "message": "rejected promise",
+ {
+   "customerCode": "C1",
+   ...
+   "id": "cmsf7xu1t000au4ijxyxeqtv8",
+   "orderId": "cmsf7xu160006u4ij3rn525ec",
+   "orderNumber": 1000,
+   "scope": "ORDER",
+   ...
+ }

 Test Files  1 failed (1)
      Tests  1 failed | 33 skipped (34)
```

`createCall` genuinely committed a second, duplicate `CertDetail` — exactly the anomaly this test
exists to catch. Repeated the apply/run cycle **3 more times** (fresh regression each time via a
scripted `perl` substitution + revert): all 4 total applications produced this identical failure
shape.

**Reverted** (`git diff --stat src/server/certs.ts` confirmed byte-identical to the committed state
after each revert).

**GREEN** — same command, lock restored:

```
 ✓ tests/certs.test.ts (34 tests | 33 skipped) 389ms
   ✓ createCert > blocks a concurrent create under Read Committed until the holder's cert commits, then refuses on the fresh read (row-lock discipline)  388ms

 Test Files  1 passed (1)
      Tests  1 passed | 33 skipped (34)
```

**Stability.** 10 additional full-file runs after the final revert, 0 failures. This test now
discriminates the exact regression the reviewer specified, confirmed by direct application rather
than inferred from the mechanism.

### Re-run gates

```
npx vitest run tests/certs.test.ts   → 34 tests, all passed (stress-run 10-15x, no flakes)
npm test                              → 80 test files, 1108 tests, all passed
npx tsc --noEmit                      → clean
npx eslint src tests                  → clean
```

### Files changed (round 3)

- `erp/tests/certs.test.ts` — replaced round 2's non-discriminating holder test with the
  Read-Committed deterministic version; retitled and re-commented the relaxed true-race test to
  honestly disclose it is not a row-lock regression guard. No production code changed (the
  regression was applied and reverted only for verification, never committed).
