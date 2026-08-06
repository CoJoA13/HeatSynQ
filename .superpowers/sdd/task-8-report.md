# Task 8 report — `shippers.ts`: create, with sorted claims, credit hold and idempotency

Branch `phase-4-certs-shipping`, commit `4bd945d`.

## What was implemented

- **`src/server/shippers.ts` (new)** — `createShipper(input, opts)` and `getShipper(id)`, plus the
  full `ShipperDetail`/`ShipperOrderDetail`/`ShipperLineDetail`/`ShipperCreateResult` types from
  the brief, verbatim.

  `createShipper`'s save transaction (`saveNewShipper`), in order:
  1. Refuses a duplicate `orderId` within one shipment.
  2. `claimOrdersInOrder(tx, orderIds)` — sorted, always, never a per-id loop.
  3. Validates: customer live; every named order live and belonging to that customer (404 for an
     unknown order, 400 for a voided one or a customer mismatch); every `orderLineId`/
     `orderContainerId`/`orderSerialId` belongs to the order it was named under; `shipToAddressId`
     (when given) is a live `SHIP_TO` of that customer.
  4. Credit hold (spec §5.4): refuses naming the customer with a link to `/customers/{id}` unless
     `opts.canOverrideCreditHold`, in which case `creditHoldReason` is required and trimmed **in
     the service**.
  5. `allocateNumber("shipper_number_next", tx)`, then `nextShipmentSequence(tx, orderId)` per
     order — inside the same claim.
  6. `assertRefExists("carrier", …, tx)` when a carrier is given.
  7. `auditedCreate("shipper", payload, …, { tx })` with the whole graph nested (`orders` ->
     `lines`/`containers`/`serials`). The credit-hold override reason and a resolved
     `shipToAddressName` ride in the audit payload only, not in a `Shipper` column.
  8. `createCert({ orderId, scope: "SHIPMENT", shipperId }, tx)` for every order whose
     `certRequired` is true and `certScope` is `SHIPMENT`.
  9. `recomputeOrderStatus(tx, orderIds)`.
  10. Warnings (never block): missing cert (any order requiring one with no live cert after step
      8/9), serialization-required line with no serial selected, and over-ship — each naming the
      order and line (`Order #<n> line <p> (<partNumber>)`).

  `clientRequestId` collisions (P2002 on `Shipper.clientRequestId`) are caught outside the
  transaction and answered with the existing shipment, `deduped: true`, reusing
  `orders.ts`'s `isDuplicateClientRequestId` (now exported) rather than re-deriving the
  driver-adapter discrimination.

- **`src/lib/permission-constants.ts`** — `override_credit_hold` added as the eleventh
  `SPECIAL_ACTIONS` entry.
- **`tests/permissions.test.ts`** — action-count assertion updated `10` -> `11`.
- **`src/server/orders.ts`** — `isDuplicateClientRequestId` exported (was private); no behavior
  change, one doc-comment addition explaining the new caller.
- **`src/server/audit.ts`** — `SNAPSHOT_INCLUDE.shipper` completed (carried-forward item 2, see
  below).
- **`tests/shippers.test.ts` (new)** — 17 tests (6 verbatim from the brief + 11 more: membership
  refusals, cert/status side effects, audit content, the two concurrency tests, and `getShipper`).

## Tests and results

`npx vitest run tests/shippers.test.ts` — **17/17 pass**, stable across 5 repeated runs (~1.0–1.1s
total; the two concurrency tests run in ~300–330ms combined, so there is no deadlock-timeout wait
happening on the happy path).

Full suite: `npm test` — **1168/1168 pass** (84 files), up from the pre-task 1151 (1010 baseline +
141 from Tasks 1–7) + this task's 17. `npx tsc --noEmit` — clean. `npx eslint src tests` — clean.
`npm run build` — succeeds.

## TDD evidence

RED (module didn't exist):

```
FAIL  tests/shippers.test.ts [ tests/shippers.test.ts ]
Error: Cannot find module '@/server/shippers' imported from '.../tests/shippers.test.ts'.
```

Then implemented `shippers.ts`. First full run against the real implementation caught three
genuine test-authoring bugs of my own (not implementation bugs), fixed before GREEN:

- `writes a create audit entry naming the customer by code, not a cuid` — my own assertion
  (`not.toContain(customer.id)`) was wrong: the payload legitimately keeps `customerId` (the real
  cuid reference) *alongside* `customerCode`/`customerName`; the point of "name, not cuid" is that
  a readable name is *also* present, not that the id is scrubbed. Rewrote to assert the readable
  fields directly.
- Concurrent-single-order test — expected both concurrent Serializable creates to succeed; one
  legitimately gets a 409 (`P2034`) under real Postgres SSI, exactly as `createOrder`'s own
  docstring documents. Rewrote to `Promise.allSettled` and accept "1 or 2 fulfilled, any rejection
  is a clean 409" — the `certs.test.ts` "supplementary, production-shape confirmation" shape.
  Retitled to say plainly it is not a deterministic row-lock regression guard.
- `getShipper` detail test — my fixture mutated `qty` on the ship line without also lowering
  `weight`, so my own expected `shippedToDateWeight` was arithmetically wrong, not the code.

GREEN after those three fixes: `17/17 pass`.

## Lock-deletion verification (both concurrency tests)

### Test: "two multi-order shipments over {A,B} and {B,A} both complete without deadlocking or a 500"

This is the one that actually discriminates `createShipper`'s own call site (as opposed to
re-proving `claimOrdersInOrder` itself, already proven in `ship-ledger.test.ts`).

**Probe (RED):** temporarily replaced `claimOrdersInOrder(tx, orderIds)` in `saveNewShipper` with
the exact anti-pattern spec §5.3 names — a loop of single-row `claimOrder(tx, id)` calls in caller
order, with a 50ms delay between claims to force the interleaving window open:

```ts
const claimed: Order[] = [];
for (const id of orderIds) {
  const row = await claimOrder(tx, id);
  if (row) claimed.push(row);
  await new Promise((resolve) => setTimeout(resolve, 50));
}
```

Result — genuinely RED, and not a hang: Postgres's own `deadlock_timeout` fired and aborted one
side with a raw, **untranslated** error (no `.status`, so it would surface as a 500 through
`handle()` in production):

```
× createShipper > two multi-order shipments over {A,B} and {B,A} both complete without deadlocking or a 500
  → expected undefined to be 409

PROBE rejection: PrismaClientKnownRequestError:
Invalid `prisma.$queryRaw()` invocation:
Raw query failed. Code: `40P01`. Message: `deadlock detected`
    at claimOrder (src/server/order-locks.ts:51:3)
    at ... shippers.ts:307:19
```

**Revert:** restored the single `claimOrdersInOrder(tx, orderIds)` call. Re-ran: GREEN, and stable
across 5 repeats (`~318–330ms` each — no deadlock-timeout delay, confirming the fast, lock-only
path is what's exercised on the happy path).

### Test: "two concurrent shipments against the SAME order never collide on a packing-list number or a sequence"

This test is explicitly titled as **not** a deterministic row-lock regression guard, per the
hard-won lesson (both sides always run Serializable through the public API — `createShipper` takes
no `tx` parameter, so there is no way to reproduce `certs.test.ts`'s Read-Committed-holder trick
against it without changing the public signature, which the brief doesn't ask for). I ran the same
probe (unsorted per-id claim loop) against it anyway, out of diligence: it still passed, because
Postgres's own SSI — with *both* sides Serializable — independently protects the numbering/sequence
uniqueness on this single-order path (the identical finding `certs.test.ts`'s own supplementary
test documents for `createCert`). This is exactly the class of test the hard-won lesson says to
title honestly rather than claim a false discriminator for, which is what its title does. The
`{A,B}`/`{B,A}` test above is the one that genuinely discriminates `claimOrdersInOrder` usage at
this call site.

## How a voided `shipperId` is guaranteed to never reach `createCert`

`createShipper` only ever calls `createCert({ orderId, scope: "SHIPMENT", shipperId }, tx)` with
`shipperId = shipper.id`, where `shipper` is the row `tx.shipper.create(...)` returned **on the
same `tx`, a few statements earlier in the same transaction**. Two facts combine to make a voided
id impossible on this path:

1. **No other caller can see this row before commit.** Postgres transaction isolation (at any
   level, including the Serializable level this transaction runs at) means an uncommitted insert
   is invisible outside its own transaction — no concurrent `voidShipper` (or anything else) can
   reference an id it cannot yet see.
2. **This transaction is the only writer of that row for its entire lifetime.** Nothing inside
   `saveNewShipper` between the `tx.shipper.create` and the `createCert` calls issues any statement
   that could soft-delete the row just inserted, and no other transaction can join in (fact 1).

So the shipment referenced by `shipperId` is, by construction, always live at the moment
`createCert` runs — voiding can only ever happen to a shipment that already exists in a *prior,
committed* transaction, and this call path never passes such an id. `Task 9/10`'s future
`voidShipper` doesn't change this: it will act on an *existing* shipment id from a *separate*
request, never on the id this transaction is still in the middle of creating.

## Files changed

- `erp/src/server/shippers.ts` (new)
- `erp/tests/shippers.test.ts` (new)
- `erp/src/lib/permission-constants.ts`
- `erp/tests/permissions.test.ts`
- `erp/src/server/orders.ts` (`isDuplicateClientRequestId` exported)
- `erp/src/server/audit.ts` (`SNAPSHOT_INCLUDE.shipper` completed)

## Carried-forward items — how each was handled

1. **`createCert` has no `assertRefExists` guard on `shipperId`.** Left unchanged (correctly, per
   the task instructions) — `assertRefExists` is exclusively the reference-kind pattern and
   `Shipper` isn't one. Guaranteed safe by construction; see the dedicated section above.
2. **`SNAPSHOT_INCLUDE.shipper` incomplete.** Fixed: `orders[].order` now also selects
   `customer: { code, name }`, and the shipper itself now selects `carrier: { name }` and
   `shipToAddress: { name }`. Verified two ways: (a) the existing
   `tests/certs-schema.test.ts` "SNAPSHOT_INCLUDE is a valid Prisma include" smoke test still
   passes (proves it's a syntactically valid include for every `AuditableModel`, unchanged
   behavior for the other 20 models); (b) `tests/shippers.test.ts`'s own
   `writes a create audit entry naming the customer by code, not only by cuid` test asserts audit
   **content** on the *create* path (the only path this task builds). `SNAPSHOT_INCLUDE.shipper`
   itself is exercised by `auditedUpdate`/`auditedSoftDelete`, which don't exist yet for `Shipper`
   until Tasks 9/10 — I fixed it now (rather than deferring) since the brief named it explicitly as
   this task's to close, and leaving it broken would have meant Task 9/10's first `updateShipper`
   call silently inherited the same unreadable-history bug Task 2's review already flagged once.

## Self-review

- **Spec compliance**: §5.3 (sorted claims, sequence allocated inside the claim, Serializable for
  the `carrierId` FK-writer, never presented as protecting the claim), §5.4 (credit hold gate,
  named+linked refusal, required+trimmed override reason, reason in audit only), §5.7 (three
  warning kinds, never blocking, each naming order+line), §6.2 (SHIPMENT-scope cert creation
  exactly at shipment save) are all implemented and covered by tests.
- **Naming**: functions/types match the brief's exact names (`createShipper`, `getShipper`,
  `ShipperDetail`, etc.). Internal helpers (`shipLineLabel`, `auditPayload`, `toDetail`,
  `readShipperDetail`) follow the `orders.ts`/`certs.ts` naming conventions already established in
  this codebase.
- **YAGNI**: did not implement `listShippers`/`updateShipper`/`addOrderToShipper`/`replaceLines`/
  `voidShipper` (Tasks 9/10) or routes (Task 11) — out of this task's scope per the brief. Did not
  add packageCount auto-sum-from-containers (a UI prefill concern per spec §4.2, not a service
  invariant). Did add one thing beyond the brief's literal text: `shipToAddressName` in the audit
  payload, for consistency with the "name, not cuid" principle the `SNAPSHOT_INCLUDE` fix itself
  establishes — a small, low-risk addition, not new functionality.
- **Test quality**: every brief-mandated test is present verbatim; the extra 11 tests cover
  membership-violation refusals, the SHIPMENT-cert creation/non-creation split, order-status
  recompute, `getShipper`'s full projection (ordered/shipped-to-date figures, containers, serials),
  and both concurrency shapes with their lock-deletion verification. No test relies on wall-clock
  sleeps for its passing assertion (the 50ms delay lives only in the temporary regression probe,
  never in committed code).
- **Pristine output**: `tsc`/`eslint`/build all clean; no `console.log`/debug artifacts left in
  either file (the probe's temporary `console.error` was removed before the final commit).

## Concerns

- The "at least one line with a positive quantity" check runs *before* the transaction opens
  (pure input validation), whereas the brief's numbered list places it inside "Step 3: Validate"
  (which is transaction-internal for the DB-dependent checks). Behaviorally identical — it's a
  fail-fast optimization, not a scope change — but noted in case the intended read was stricter
  step-for-step ordering.
- `route`/`comments`/`freightDescription` max-lengths (200/2000/200) are my own reasonable choices
  — the brief pins only `decimalField` fields and `freightClass`/`proNumber`/`scacCode` at
  `.max(30)` explicitly; nothing in spec or brief pins the others, and no test depends on the exact
  bound.
- `clientRequestId` is validated as a plain non-empty string (`.min(1).max(200)`), not `.uuid()`
  like `Order.clientRequestId` — required because the brief's own idempotency test uses
  `"nonce-1"`, not a UUID. Flagging this divergence from the `Order` precedent explicitly in case a
  future caller assumed UUID-only.

---

## Review round 1 — Approved, six Minors addressed (2026-08-04)

Reviewer verdict: Approved, no Critical/Important findings. All six Minors taken, plus the
standalone `parseDate` fast-path note. Commit `f740810`.

### 1. Latent module cycle — `INT4_MAX` moved to a leaf module

Moved `INT4_MAX` out of `orders.ts` into `src/lib/order-constants.ts` (already existed, already
client-safe, already the home for `ORDER_STATUSES`/`OrderStatusValue`). `orders.ts` and
`order-loads.ts` now import it from there directly; `shippers.ts` no longer touches `orders.ts` for
it at all — the only thing it still imports from `orders.ts` is `isDuplicateClientRequestId`, a
hoisted `function` declaration, which the reviewer correctly identified as safe across a future
`orders.ts` <-> `shippers.ts` cycle (Task 10's `shipmentBlockers`) because hoisting means it exists
before any top-level code in either module runs, regardless of which side evaluates first. A `const`
consumed inside a top-level zod schema does not have that property — it is exactly the shape that
throws in the temporal dead zone the moment the evaluation order starts on the wrong side.

Verified: `npx tsc --noEmit` clean; `npm test` full suite green, including `tests/orders.test.ts`
(125 tests) and `tests/order-loads.test.ts` (29 tests) re-run explicitly since both consume
`INT4_MAX` through the new import path.

### 2. `SNAPSHOT_INCLUDE.shipper` — shipper-level `customer` select added

Added `customer: { select: { code: true, name: true } }` beside `carrier`/`shipToAddress` at the
top of `SNAPSHOT_INCLUDE.shipper` (`src/server/audit.ts`), so a customer name resolves even when
`orders[]` is empty — reachable once Task 10's `removeOrderFromShipper` hard-deletes the last
`ShipperOrder` row (it has no `deletedAt` of its own, spec §4.2). Comment updated to explain why the
shipper-level selects exist independently of the orders-side ones, not merely redundantly. Verified
against `tests/certs-schema.test.ts`'s existing "SNAPSHOT_INCLUDE is a valid Prisma include" smoke
test (still passes — proves the new selects compile against real Prisma relations); asserting its
*content* remains Task 9's, per the coordinator's note, since `auditedCreate` never calls
`snapshot()` and `Shipper` has no update/void path yet.

### 3. Duplicate child id within one order — refused by name, proactively

Extended the existing membership-check loop (already walking `lineById`/`containerById`/
`serialById` with resolved names) to also track a per-order `Set` of seen ids for
lines/containers/serials, throwing a message naming the duplicated child the moment a repeat is
seen — `Order #<n> line <p> (<partNumber>): listed twice on this shipment`,
`Order #<n>: container "<typeName>" is listed twice on this shipment`,
`Order #<n>: serial "<value>" is listed twice on this shipment`. Made proactive rather than reactive
(unlike `orders.ts`'s `duplicateSerialError`, which re-walks the payload after a P2002): the
resolved rows already exist at that point in `saveNewShipper`, so there is no P2002 shape to
discriminate and no reactive re-walk needed — a strictly simpler fix that still fully satisfies "the
service refuses, naming what's blocking" rather than falling through to
`withDbErrors({ conflictField: "shipper number" })`'s generic message.

**RED verified by hand**: temporarily disabled all three `seen*.has(...)` checks (kept the
`.add(...)` calls) and ran the three new tests
(`refuses a duplicate order line/container/serial within one shipment, naming it`):

```
× refuses a duplicate order line within one shipment, naming it
  → expected [Function] to throw error matching /line 1.*listed twice/i
    but got 'A shipper with that shipper number already exists'
× refuses a duplicate container within one shipment, naming it
  → ... but got 'A shipper with that shipper number already exists'
× refuses a duplicate serial within one shipment, naming it
  → ... but got 'A shipper with that shipper number already exists'
```

This is the exact misleading message the review flagged. Reverted the probe: all three GREEN.

### 4. Deadlock probe re-run without amplification — five repeats, honestly recorded

Re-ran the exact anti-pattern probe (unsorted per-id `claimOrder` loop replacing
`claimOrdersInOrder`) against the `{A,B}`/`{B,A}` test, this time with **no** `setTimeout` between
the loop's two claims, five repeats:

```
run 1: PASS (223ms)
run 2: PASS (258ms)
run 3: PASS (242ms)
run 4: PASS (258ms)
run 5: PASS (267ms)
```

**5/5 green — the un-amplified probe does NOT reliably reproduce the regression** in this
environment. This local Postgres is fast enough that one side's whole two-statement claim loop
usually completes before the other side's first statement even lands, so the ABBA window never
opens without help forcing it. This is not a new finding — it is the *identical* result
`ship-ledger.test.ts`'s own `claimOrdersInOrder` suite already documented for this exact shape one
level down ("the plain swap alone was NOT a reliable RED on its own... needed a short artificial
delay"). The earlier RED demonstration in this file's own report (with the 50ms delay) is genuine —
it did produce a real, untranslated Postgres `deadlock detected` (40P01) — but it demonstrates the
anti-pattern is *capable* of deadlocking, not that this specific test would *reliably* catch a
silent regression to it under ordinary CI timing.

Per the hard-won lesson ("if a test cannot be made deterministic, say so in its title"), retitled the
test to say so explicitly:
`"two multi-order shipments over {A,B} and {B,A} both complete without deadlocking or a 500 (not a
deterministic row-lock regression guard without artificial delay — see comment)"`, with a comment
recording both probe results and pointing at the two existing precedents
(`tests/certs.test.ts:187`, `tests/ship-ledger.test.ts:290`). The test still has real value — it
proves the production-shape, real-timing behavior is correct today — it is just not, on its own,
airtight proof against a future regression the way the RED-with-delay demonstration is.

### 5. `comments` aligned to 4000

`z.string().max(2000)` -> `z.string().max(4000)`, matching every other long free-text field's
convention in the codebase.

### 6. Test hygiene

- Removed the unused `customer`/`b` bindings (`void customer;`, `void b;`) — one was a genuinely
  dead `savedOrder()` call, deleted outright; the other was simplified to destructure only what the
  test uses.
- `containers: [] as unknown[]` / `serials: [] as unknown[]` in `oneOrderInput`/`zeroQtyInput`
  replaced with two proper local types, `ShipContainerInput`/`ShipSerialInput`, so the tests that
  mutate these arrays in place (`does not warn once a serial is selected...`, `returns full
  detail...`) stay type-checked instead of opting out of it.

### Also: `parseDate` moved to the pre-transaction fast path

`parseDate(data.shipDate, "Ship date")` now runs in `createShipper` itself, alongside the existing
`qty > 0` check, before `withDbErrors`/the transaction opens — equally pure (no DB dependency) as
that check. `saveNewShipper` now takes the already-parsed `shipDate: Date` as a parameter instead of
re-parsing the raw string inside the transaction.

### Gates re-run after all six fixes

- `npx vitest run tests/shippers.test.ts` — **20/20 pass** (17 original + 3 new duplicate-child
  tests), stable.
- `npx vitest run tests/orders.test.ts tests/order-loads.test.ts` — **154/154 pass** (the
  `INT4_MAX`-move-touches-consumers re-run the coordinator asked for).
- `npm test` (full suite) — **1171/1171 pass** (84 files).
- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npm run build` — succeeds.

### Files touched in this round

- `src/lib/order-constants.ts` (`INT4_MAX` added)
- `src/server/orders.ts` (`INT4_MAX` import instead of local `const`)
- `src/server/order-loads.ts` (`INT4_MAX` import path updated)
- `src/server/shippers.ts` (duplicate-child refusal, `comments` bound, `parseDate` relocation,
  `INT4_MAX` import path)
- `src/server/audit.ts` (`SNAPSHOT_INCLUDE.shipper` shipper-level `customer` select)
- `tests/shippers.test.ts` (3 new tests, retitled deadlock test + expanded comment, test-hygiene
  fixes)
