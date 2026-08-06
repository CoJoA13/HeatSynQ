# Task 7 report — `ship-ledger.ts`: shipped totals, status derivation, shipment sequence, sorted claims

Branch: `phase-4-certs-shipping`
Commits:
- `2dde98b` — `refactor(orders): extract claimOrder into a leaf order-locks.ts`
- `6ef8e5d` — `feat(shipping): ship ledger, status derivation, shipment sequence, sorted claims`

## What was implemented

### 1. `src/server/order-locks.ts` (new leaf module)

- **`claimOrder(tx, orderId)`** — moved from `orders.ts` with a byte-identical BODY. **Correction
  (review round 2):** the original version of this report claimed the doc comment was
  byte-identical too — it was not. The comment's opening sentence was edited to name the new
  callers accurately (added "(orders.ts)" to disambiguate the mutator list, and added
  `certs.ts`'s `claimCertsOrder` to the list of things that open with this claim); the rest of the
  comment is unchanged. Imports nothing but `Prisma`/`Order` types from the generated Prisma
  client, plus `HttpError` (./errors, a zero-import leaf) once `claimCertsOrder` joined it — see
  the review-response section at the end of this report.
- **`sortedClaimIds(orderIds)`** — `[...new Set(orderIds)].sort()`, exported on its own so a plain
  unit test can discriminate on the ordering directly (see "concurrency test design" below for why
  this was necessary).
- **`claimOrdersInOrder(tx, orderIds)`** — one `SELECT "id" FROM "Order" WHERE "id" = ANY($1) ORDER
  BY "id" FOR UPDATE`, then `findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } })`.
  Empty input short-circuits to `[]` without a query.

### 2. `src/server/ship-ledger.ts` (new)

- **`shippedTotals(db, orderLineIds)`** → `Map<orderLineId, { qty, weight }>`, summed only over
  `ShipperLine` rows whose `shipperOrder.shipper.deletedAt` is null. A line with no live shipment
  has no entry in the map (sparse, the `certs.ts` `sequenceMap` precedent) rather than a
  `{ qty: 0, weight: 0 }` entry.
- **`recomputeOrderStatus(tx, orderIds)`** — for each live (non-voided) order in the set: no live
  shipper lines → `OPEN`; every order line has ≥1 live shipper line with `lineComplete = true` →
  `SHIPPED`; otherwise → `PARTIAL_SHIPPED`. One batched query for every affected order's lines and
  one batched query for their shipper lines (not N+1). Writes through `auditedUpdate("order", …)`
  and ONLY when the derived status actually differs from the stored one, so a qty/weight-only edit
  (which can never move the needle, since quantities never enter the decision) writes no spurious
  audit entry. Skips voided orders outright.
- **`nextShipmentSequence(tx, orderId)`** — `_max` over `shipperOrder` for the order, **no live
  filter** (a voided shipment's rows are still counted — `ShipperOrder` carries no `deletedAt` of
  its own), `+ 1`.

### 3. `src/server/orders.ts`

- `claimOrder` import repointed to `./order-locks`; the old in-file definition removed (the
  now-unused `Order` type import was also dropped, confirmed via `tsc`).
- `addLine`, `updateLine`, `removeLine` each call `recomputeOrderStatus(tx, [orderId])` at the end
  of their existing transaction, before the final `readDetail` — `addLine`/`removeLine` because the
  line SET changes (spec §5.2's rider/removal case); `updateLine` for uniformity even though it's a
  guaranteed no-op today (qty/weight never enter the decision).

### 4. Callers re-pointed (mechanical, zero behaviour change)

`certs.ts`, `attachments.ts`, `order-loads.ts`, `traveler.ts` now import `claimOrder` from
`./order-locks` instead of `./orders`.

## Module cycle — confirmed gone

Before: `certs.ts` imported `claimOrder` from `orders.ts`; `orders.ts` imported
`resolveCertSettings`/`createCert` from `certs.ts` — a genuine bidirectional cycle.

After:
```
$ grep -n 'from "\./orders"' src/server/certs.ts
(no output)
$ grep -n 'from "\./certs"' src/server/orders.ts
13:import { resolveCertSettings, createCert, type CertResolution } from "./certs";
$ grep -n 'from "\./order-locks"' src/server/certs.ts
15:import { claimOrder } from "./order-locks";
```
`orders.ts → certs.ts → order-locks.ts` is now one-directional. `order-locks.ts` itself imports
only `Prisma`/`Order` types from the generated client — confirmed by reading the file back.

I also ran a small script walking every `src/server/*.ts` file's local (`./x`) imports looking for
cycles. It originally reported two more: `context.ts → sessions.ts → settings.ts → audit.ts →
context.ts`, and `cert-results.ts → certs.ts → cert-results.ts`. **Both claims needed correction —
see the review-response section at the end of this report for what changed and why.**

## Tests — 15 new, all passing; full suite green

`npx vitest run tests/ship-ledger.test.ts`:
```
✓ shippedTotals > excludes voided shipments from shipped-to-date
✓ shippedTotals > has no entry for a line with no live shipment at all
✓ shippedTotals > returns an empty map for an empty id list
✓ recomputeOrderStatus (via getOrder) > derives status from ship-line-complete, never from quantity
✓ recomputeOrderStatus (via getOrder) > stays OPEN with no live shipper lines at all
✓ recomputeOrderStatus (via getOrder) > returns a SHIPPED order to PARTIAL_SHIPPED when a rider line is added
✓ recomputeOrderStatus (via getOrder) > leaves a voided order's status untouched
✓ nextShipmentSequence > never reissues a shipment sequence after a void
✓ nextShipmentSequence > starts at 1 for an order with no shipments yet
✓ sortedClaimIds > dedupes and sorts ascending, independent of caller order
✓ sortedClaimIds > is a pure no-op on an already-sorted, deduped list
✓ claimOrdersInOrder > returns every requested order sorted ascending by id, regardless of caller order
✓ claimOrdersInOrder > dedupes a repeated id
✓ claimOrdersInOrder > returns an empty array for no ids
✓ claimOrdersInOrder > claims two orders concurrently in either caller order without deadlocking

Test Files  1 passed (1)
     Tests  15 passed (15)
```

Full suite: `npm test` → **83 test files, 1151 tests, all passing** (was 1010 at the CLAUDE.md
baseline before this phase; Tasks 1–6 already grew it, this task added 15 net new).
`npx tsc --noEmit` → clean. `npx eslint src tests` → clean. `npm run build` → succeeds.

I additionally verified the **extraction commit in isolation**: with `ship-ledger.ts` and its test
file set aside and the `recomputeOrderStatus` hooks temporarily stripped back out of `orders.ts`,
the tree still built clean (`tsc`, `eslint`) and **1136/1136** pre-existing tests passed unchanged
— direct proof the extraction itself is a genuine zero-behaviour-change refactor, not just an
assertion.

## TDD evidence

**RED** — `npx vitest run tests/ship-ledger.test.ts`, run against the tree with `order-locks.ts`
(extraction + `claimOrdersInOrder`) already in place and the `orders.ts` hooks wired, but
`ship-ledger.ts` not yet created:
```
FAIL  tests/ship-ledger.test.ts [ tests/ship-ledger.test.ts ]
Error: Cannot find module './ship-ledger' imported from
'/home/cojoa13/Desktop/HeatSynQ/erp/src/server/orders.ts'
 ❯ src/server/orders.ts:15:1
     13| import { resolveCertSettings, createCert, type CertResolution } from "…
     14| import { claimOrder } from "./order-locks";
     15| import { recomputeOrderStatus } from "./ship-ledger";
Test Files  1 failed (1)
     Tests  no tests
```
Expected: the whole suite (all 15 cases, including the ones exercising `shippedTotals`,
`recomputeOrderStatus` and `nextShipmentSequence` directly) fails to even load, because none of
those three functions existed yet.

**GREEN** — after implementing `ship-ledger.ts` and fixing two unrelated test-fixture issues (see
below): `npx vitest run tests/ship-ledger.test.ts` → **15 passed (15)**, shown above.

Two of the fifteen cases initially failed for a reason unrelated to the ledger logic itself: my
first draft created three/two orders via `Promise.all([savedOrder(), …])`, and `createOrder` is
Serializable with an `allocateNumber` claim that is a write-write conflict under real concurrent
callers — exactly the documented, expected 409 `orders.test.ts`'s own `createConcurrently` helper
describes. I don't need genuine concurrency there (only distinct order ids), so I replaced it with
a small sequential `savedOrderIds(n)` helper. Not a correctness bug in the code under test.

**Extraction step (order-locks.ts / claimOrder)** — per the brief, "a moved function with no
behaviour change needs no new tests." No new test was written for `claimOrder` itself; the existing
suites covering every caller (`orders.test.ts`, `certs.test.ts`, `attachments.test.ts`,
`order-loads.test.ts`, `traveler.test.ts`, plus every route test that exercises them) are the proof
— all left untouched and still green (see the full-suite run above, and the isolated
extraction-only verification with 1136/1136 passing).

## Lock-deletion RED/GREEN evidence — the concurrency test

Target test: `claimOrdersInOrder > claims two orders concurrently in either caller order without
deadlocking` (`tests/ship-ledger.test.ts`).

**First attempt (plain swap, NOT reliable — recorded honestly):** I temporarily replaced
`claimOrdersInOrder`'s body with the exact anti-pattern spec §5.3 names — a loop of single-row
`claimOrder`-shape claims in the CALLER's own order, no sort, no single ordered statement:
```ts
for (const id of orderIds) {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`;
}
```
Running the target test 3× against this: **all 3 runs still PASSED.** Diagnosis: this local
Postgres (docker, same host) is fast enough that one side's whole two-statement loop routinely
completes and commits before the other side's connection is even established and its first
statement lands — so the two callers never actually contend for the same row at the same instant,
and the ABBA cycle the anti-pattern is vulnerable to never gets a chance to form. This is the same
class of false-negative CLAUDE.md's Task 5 lesson warns about (a hazard masked by something other
than the mechanism under test — there SSI, here plain scheduling luck), so I did not stop there.

**Widened-window reproduction (the real RED):** I added a 75ms artificial delay between the naive
loop's two per-row claims (verification-only, never committed) to give the other side a realistic
window to land its own first claim before either attempts its second:
```ts
for (const id of orderIds) {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`;
  await new Promise((resolve) => { setTimeout(resolve, 75); });
}
```
`npx vitest run tests/ship-ledger.test.ts -t "deadlock"`, 3 runs:
```
Invalid `prisma.$queryRaw()` invocation:
Raw query failed. Code: `40P01`. Message: `deadlock detected`
 ❯ claimOrdersInOrder src/server/order-locks.ts:84:5
Tests  1 failed | 14 skipped (15)
```
**RED 3/3** — Postgres's own deadlock detector found the ABBA cycle (txAB holds A, wants B; txBA
holds B, wants A) and aborted one side with `40P01` after `deadlock_timeout`, which surfaces as a
rejected promise in the test. This is the conclusive proof the hazard spec §5.3 describes is real
under genuine concurrent contention.

**Revert and GREEN:** restored `order-locks.ts` to the single ordered statement (`ANY($1) ORDER BY
"id" FOR UPDATE`) and confirmed byte-identical to the pre-verification file (`diff` empty). Re-ran
3×:
```
✓ tests/ship-ledger.test.ts (15 tests) 785ms / 770ms / 772ms
Tests  15 passed (15)
```
**GREEN 3/3.** I also confirmed via `EXPLAIN` on the real Postgres instance that the single
statement's plan places `LockRows` **above** `Sort` —
```
LockRows
  -> Sort
       Sort Key: "Order".id
       -> Seq Scan on "Order" ... Filter: (id = ANY(...))
```
— i.e. Postgres locks rows in the *sorted* sequence, not scan order, which is the structural reason
the single-statement claim is deadlock-immune by construction (no window exists between "claim A"
and "claim B" for a competing transaction to land its own partial claim in) rather than merely
"usually fast enough to avoid it."

**Honesty note for the record:** the *committed* test (no artificial delay, natural `Promise.all`
race) is not a fully deterministic discriminator on its own — as shown above, it can pass even
against the naive implementation if the two transactions happen not to overlap. It remains in the
suite because it's a genuine positive proof of the shipped, correct behavior (two concurrent
full-set claims over the same order pair complete without error), and it's exactly the shape the
brief's own fallback describes ("one integration test proving two concurrent `claimOrdersInOrder`
calls over `{A,B}` and `{B,A}` both complete"). The deterministic proof that the *hazard itself* is
real, and that the shipped fix eliminates it, is the widened-window reproduction above plus the
`EXPLAIN`-confirmed structural reasoning, both recorded here per the brief's request for "both
transcripts."

## Files changed

- `erp/src/server/order-locks.ts` (new) — `claimOrder` (moved), `sortedClaimIds`,
  `claimOrdersInOrder`
- `erp/src/server/ship-ledger.ts` (new) — `shippedTotals`, `recomputeOrderStatus`,
  `nextShipmentSequence`
- `erp/src/server/orders.ts` — `claimOrder` removed (moved out), `recomputeOrderStatus` hooked into
  `addLine`/`updateLine`/`removeLine`
- `erp/src/server/certs.ts`, `erp/src/server/attachments.ts`, `erp/src/server/order-loads.ts`,
  `erp/src/server/traveler.ts` — `claimOrder` import repointed to `./order-locks`
- `erp/tests/ship-ledger.test.ts` (new) — 15 tests, fixtures write `Shipper`/`ShipperOrder`/
  `ShipperLine` directly via `prisma.*.create` per the fixtures note (no import from `shippers.ts`)

## Self-review

- **Spec compliance (§5.1/§5.2/§5.3):** shipped-to-date excludes voided shipments only ✓; status
  derives from `lineComplete` alone, never quantity ✓; voided orders skipped, `INVOICED`/`REOPENED`
  never written (the type system doesn't even let `recomputeOrderStatus` produce them — only
  `OPEN`/`PARTIAL_SHIPPED`/`SHIPPED` are constructible) ✓; sequence never reissued, no live filter ✓;
  claims taken in sorted id order, single statement ✓.
- **Naming:** matches the brief's interfaces verbatim (`ShippedTotal`, `shippedTotals`,
  `recomputeOrderStatus`, `nextShipmentSequence`, `claimOrder`, `claimOrdersInOrder`). Added
  `sortedClaimIds` per the brief's own fallback suggestion for a unit-testable ordering assertion —
  exported from `order-locks.ts` rather than `orders.ts` as the brief's fallback paragraph literally
  says, because that paragraph predates the later-added extraction note (the "Produces" section
  right above it already shows `claimOrdersInOrder` living in `order-locks.ts`); colocating the sort
  helper with the function it supports seemed clearly correct given that.
- **YAGNI:** did not add a `shipmentBlockers` stub or anything for Task 8/9/10 — out of scope here.
  Did not add a live-only variant of `shippedTotals` or speculative caching.
- **Test quality:** every brief-specified test case is present; added a handful of narrow
  supplementary cases (empty-map, empty-id-list, OPEN-with-nothing-shipped, dedup, voided-order-skip
  with a real discriminating scenario) that cost little and closed real gaps. Assert real values, not
  just "no throw."
- **Audit compliance:** `recomputeOrderStatus` writes exclusively through `auditedUpdate` (no new
  audit exception — global constraints explicitly forbid adding one this phase), and only when the
  status actually changes, so it never pollutes an order's history with no-op "update" entries on a
  quantity-only edit.
- **Output pristine:** `tsc`/`eslint` clean, no `console.log`/debug leftovers, no commented-out code,
  the temporary verification edits were reverted byte-identical (diffed to confirm) before either
  commit.

## Concerns

- The committed concurrency test is a real, honest test of the shipped behavior, but — as detailed
  above — it is not a airtight, deterministic regression guard against a future accidental
  reintroduction of the per-id anti-pattern on a very fast/local database, since natural race timing
  doesn't reliably force contention. I considered but rejected baking the artificial delay into the
  permanent implementation or test (it would be dead weight in production code, and a
  delay-dependent test is its own kind of flaky). Flagging this so a future reviewer knows the
  discriminator's actual power rather than assuming it's airtight.
- ~~Two other, pre-existing module cycles were found while confirming this one was gone
  (`context.ts`↔`sessions.ts`↔`settings.ts`↔`audit.ts`, and `cert-results.ts`↔`certs.ts`). Both are
  out of this task's scope and untouched by it; noting for awareness only, not fixed.~~ **Resolved
  in review round 2 — see below.** The `context.ts` chain was a false positive (my detector didn't
  distinguish `import type` from value imports); the `cert-results.ts`/`certs.ts` chain was real
  and is now fixed the same way `orders.ts`/`certs.ts` was.

---

## Review round 2 — response to Task 7's approval follow-ups

Task 7 came back **Approved** with three Minor follow-ups. All four items below are addressed.
Commits:
- `8685b24` — `refactor(certs): extract claimCertsOrder/readCertDetail to break the certs.ts <-> cert-results.ts cycle`
- `590159e` — `docs: retitle the deadlock test and fix stale claimOrder cross-references`

### 1. The second cycle (real) — `certs.ts` <-> `cert-results.ts` — now fixed

Confirmed by the reviewer: `cert-results.ts` imported `claimCertsOrder` and `readCertDetail` from
`certs.ts`, while `certs.ts` imported `seedRequirements` from `cert-results.ts` — the identical
bidirectional-cycle shape Task 7 broke for `orders.ts`/`certs.ts`, safe only because every crossing
export was a hoisted `function` declaration.

**What moved, and where — I deviated slightly from the suggested seam, noted below:**

- **`claimCertsOrder` → `order-locks.ts`**, exactly as suggested — a lock helper belongs beside the
  lock (`claimOrder`) it wraps. Needed one new import there: `HttpError` from `./errors`, which is
  itself the zero-import leaf (see `errors.ts`'s own doc comment) — importing it can never
  reintroduce a cycle, so this doesn't violate "order-locks.ts imports only db/Prisma types" in
  spirit; it's the one other leaf every service in this codebase already depends on.
- **`readCertDetail` → `cert-results.ts`**, exactly as suggested, along with its three private
  helpers that have no other caller: `DETAIL_INCLUDE`, `type DetailRow`, `toCertDetail`, and the
  `num` decimal-to-number helper (used only inside `toCertDetail`).
- **Deviation:** `readCertDetail` also needs a shipment-sequence lookup for SHIPMENT-scope certs.
  The existing implementation called certs.ts's own `sequenceMap` (which batches the lookup across
  many rows, for `listCerts`/`certsForOrder`'s list view). Moving `readCertDetail` without also
  moving `sequenceMap` would have meant importing `sequenceMap` back from `certs.ts` — recreating a
  cycle, just a narrower one. Moving `sequenceMap` itself was the other option, but `certs.ts`'s own
  `rowsToCertRows` (the list view) still needs its BATCHED form, so that move would have needed
  `certs.ts` to import it back from `cert-results.ts` — no better. Instead, `readCertDetail` in
  `cert-results.ts` now does its OWN single-pair, un-batched query
  (`db.shipperOrder.findFirst({ where: { shipperId, orderId }, select: { sequence: true } })`)
  rather than calling the batched helper — correct for its actual call shape (exactly one cert),
  and it keeps `sequenceMap`'s batching optimization scoped to where the N+1 risk is real (the list
  view). Documented in both functions' doc comments so a future reader doesn't wonder why the
  "same" lookup exists twice.
- **`certs.ts`'s own leftovers:** `getCert` and `createCertInTx` now call the imported
  `readCertDetail`; `updateCert`/`voidCert` now call the imported `claimCertsOrder`. The `formatDateOnly`
  import became unused once `toCertDetail` left and was removed (confirmed via `tsc`/`eslint`, both
  clean).
- **`import type { CertDetail } from "./certs"` stays in `cert-results.ts`.** This is deliberate,
  not a leftover: `CertDetail` is `certs.ts`'s own return-type shape, and `cert-results.ts`'s
  `readCertDetail`/`replaceReadings` both return it. Per the corrected understanding from item 2
  below, a type-only import is erased at compile time and creates no runtime edge — it is NOT part
  of the cycle, the same way `context.ts`'s `import type { SessionUser }` from `sessions.ts` isn't
  part of a cycle with it. `cert-results.ts` now has **zero VALUE imports from `certs.ts`**, which
  is the property that actually matters (the hoisted-function-declaration safety net Task 5/7 both
  reasoned about only applies to values, never to types).

No new tests were written for either moved function, per the same "a moved function with no
behaviour change needs no new tests" rule Task 7 itself used — the existing suites covering every
caller are the proof.

**Verification:**
```
$ grep -n 'from "\./certs"' src/server/cert-results.ts
16:import type { CertDetail } from "./certs";
$ grep -n 'from "\./cert-results"' src/server/certs.ts
19:import { seedRequirements, readCertDetail } from "./cert-results";
$ grep -n 'from "\./order-locks"' src/server/cert-results.ts
10:import { claimCertsOrder } from "./order-locks";
```
`certs.ts → cert-results.ts` and `certs.ts → order-locks.ts` are now the only edges; `cert-results.ts`
has no VALUE edge back to `certs.ts` at all.

### 2. Cycle-detector false positive — corrected

The reviewer is right: `context.ts:4` is `import type { SessionUser } from "./sessions"`, which
TypeScript erases completely — there is no runtime edge, so `context.ts → sessions.ts →
settings.ts → audit.ts → context.ts` was never a real cycle. My first script walked EVERY `from
"./x"` line regardless of whether the import was `import type` or a value import, so it couldn't
tell the two apart.

**Fix:** skip any line matching `^\s*import\s+type\s` (a whole-statement type-only import) before
extracting the edge; a mixed line like `import { type Foo, bar } from "./mod"` still counts, since
it genuinely does import a value (`bar`) and is a real edge. Re-ran the corrected detector against
the CURRENT tree (both cycle fixes applied):
```
$ python3 <the corrected script>
done
```
Zero `CYCLE:` lines — no cycles at all remain among `src/server/*.ts`'s value-import graph. (For
the record: the corrected detector also silently resolves what would have been a `context.ts`
false-negative-turned-non-issue — with `import type` excluded, that chain simply never appears,
confirming it was never real rather than "real but now also fixed.")

### 3. Deadlock test retitled

`tests/ship-ledger.test.ts`'s concurrency test is now titled:
> `"claims two orders concurrently in either caller order without deadlocking (not a deterministic row-lock regression guard — see comment)"`

matching the `tests/certs.test.ts:187` house precedent (`"... — not a row-lock regression guard —
see comment"`) so the caveat is visible in a bare test-run summary, not only to someone who opens
the file and reads the block comment above it. Re-ran: still 15/15 passing.

### 4. Stale cross-references swept

All four call sites the reviewer named still described `claimOrder` as living in `orders.ts` after
Task 7 moved it to `order-locks.ts`:

- `src/server/attachments.ts:142` — `` `claimOrder` (orders.ts) `` → `` `claimOrder` (order-locks.ts) ``
- `src/server/traveler.ts:595` — same fix
- `src/server/traveler.ts:606-607` — same fix (also re-wrapped the surrounding paragraph, which had
  drifted past the file's line-length convention after the edit; `eslint` confirms it's fine now)

I also swept two more the reviewer didn't explicitly list but which had the identical staleness,
since "this codebase leans on doc comments as its map of why things are the way they are" applies
equally to test files:
- `tests/order-loads.test.ts:284` — `` `claimOrder` (orders.ts) `` → `` `claimOrder` (order-locks.ts) ``
- `tests/traveler.test.ts:491` — `` `claimOrder`, orders.ts `` → `` `claimOrder`, order-locks.ts ``

Grepped the whole repo afterward for any remaining `claimOrder` + `orders.ts` co-occurrence; the
only survivors are (a) historically-accurate past-tense statements ("`claimOrder` lived in
orders.ts" — describing what USED to be true, in the two files' own cycle-explanation comments) and
(b) `orders.ts`'s own call sites (`const order = await claimOrder(tx, orderId);` — accurate,
`claimOrder` really is called from there, just no longer DEFINED there). Neither needed a change.

Also corrected this report's own earlier over-claim (flagged in the reviewer's item 4): the moved
`claimOrder`'s BODY was byte-identical, but its doc comment was lightly edited (to name the new
callers) — not byte-identical as originally stated. Fixed in place above rather than only appended
here, so a reader skimming from the top doesn't hit the wrong claim first.

### Re-verification after all four fixes

```
$ npx vitest run tests/certs.test.ts tests/cert-results.test.ts tests/ship-ledger.test.ts
Test Files  3 passed (3)
     Tests  64 passed (64)

$ npx vitest run tests/certs.test.ts tests/cert-results.test.ts tests/ship-ledger.test.ts \
    tests/attachments.test.ts tests/traveler.test.ts tests/order-loads.test.ts tests/orders.test.ts
Test Files  7 passed (7)
     Tests  286 passed (286)

$ npm test
Test Files  83 passed (83)
     Tests  1151 passed (1151)

$ npx tsc --noEmit   # clean
$ npx eslint src tests   # clean
```

No test file needed a behavior change — every green result above is the existing suite proving the
extraction, exactly as Task 7's own extraction was proven the same way.
