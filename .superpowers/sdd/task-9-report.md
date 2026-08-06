# Task 9 report — shipment children: replace grids, add and remove orders

## What was implemented

`src/server/shippers.ts` gained the six mutators and three read functions the brief's interface
block specifies, verbatim:

- `updateShipper(id, input)` — header-only patch (ship-to, ship date, carrier, route, comments,
  freight fields, package count, pro/scac). `customerId`, `clientRequestId`, `shipperNumber` and
  `bolNumber` stay immutable (every order already on the shipment was validated against the
  customer at add-time; letting it change would silently invalidate that).
- `addOrderToShipper(id, orderId)` — attaches another order of the same customer, allocating its
  own `sequence` (`nextShipmentSequence`) and appending at `MAX(position) + 1`.
- `removeOrderFromShipper(id, shipperOrderId)` — hard-deletes the `ShipperOrder` row (and its
  RESTRICT-FK children, deleted first) and closes the position gap with a two-phase negative-park
  renumber (the `order-loads.ts` `applyLoads` precedent). Refused once a shipping ticket — this
  order's own or a whole-set print (`orderId: null`) — has printed for this shipment (spec §5.5,
  2026-08-04 addition), naming the packing list and pointing at voiding the shipment instead.
- `replaceShipperLines` / `replaceShipperContainers` / `replaceShipperSerials(id, shipperOrderId,
  input)` — delete-then-recreate bulk PUTs for one `ShipperOrder`'s three grids, each child
  validated to belong to the SAME order the `ShipperOrder` points at, duplicates refused by name.
- `listShippers(filter)` / `exportShippers(filter)` / `shipmentsForOrder(orderId)` — the shipping
  list, its Excel export, and the order-hub's per-order shipment history (voided included), with
  `ShipperFilter`/`ShipperRow` matching the brief's types exactly. Search covers packing-list
  number, BOL number, order number and customer code; `includeVoided` defaults off.

Every mutator follows the brief's canonical shape: `withDbErrors` → Serializable `$transaction` →
resolve-and-check-liveness on the shipper (404 on missing OR voided) → `claimOrdersInOrder(tx,
everyAffectedOrderId)` → `auditedUpdate("shipper", id, …)` for the write → `recomputeOrderStatus`.
"Every affected order" is always the full set currently on the shipment (plus the incoming order
for `addOrderToShipper`) — even a header-only edit claims the whole set, matching `updateLine`'s
own established reasoning in `orders.ts` for calling `recomputeOrderStatus` uniformly rather than
letting one mutator quietly depend on "this write can never touch another order."

One small addition beyond the brief's literal "Produces" list: `overshipWarnings(detail:
ShipperDetail): string[]`, exported. See "Design decision" below for why.

## Design decision: `overshipWarnings` instead of a `{shipper, warnings}` wrapper

The brief's interface block types all six mutators as returning bare `Promise<ShipperDetail>` —
no `warnings` array, unlike Task 8's `createShipper` (`ShipperCreateResult = {shipper, warnings,
deduped}`). But Step 7 says: "Run the tests — PASS, plus a `replaceShipperLines` test asserting
the over-ship warning appears and the save still succeeds," which reads like it wants a returned
message.

I kept the six signatures exactly as specified (the brief says to use its exact code verbatim) and
added a small, separate pure export, `overshipWarnings`, that derives the over-ship condition
straight off an already-built `ShipperDetail`'s own `shippedToDateQty`/`orderedQty` fields — no
second DB read. I verified the algebra: `shippedToDateQty` (post-write, via `shippedTotals`)
already equals `prior + thisShipment'sQty`, so `shippedToDateQty > orderedQty` is exactly the same
fact `saveNewShipper`'s own pre-save check (`qty > remaining`) tests, just observed from the other
side of the write. The `replaceShipperLines` test calls `overshipWarnings(after)` on the mutator's
return value rather than expecting the warning bundled into it.

The independent `task-reviewer` pass (see below) examined this specifically and agreed it's the
more defensible reading of a genuine brief ambiguity, while flagging for whoever builds the route
layer (Task 11) that they need to remember to call `overshipWarnings` separately — it is not
bundled into `replaceShipperLines`'s own return.

## What was tested

New file `tests/shipper-children.test.ts`, 39 tests, covering:

- The five brief-verbatim Step 1 tests (add/remove behavior, status recompute, position closing).
- Step 5's two print-refusal tests (own-order print, whole-set print).
- Step 5a: 7 composition tests (createShipper + all six new mutators) using a house-legal
  `vi.mock("@/server/order-locks", …)` module-boundary mock — the real implementations are
  preserved (`vi.fn(actual.fn)`), only call-recording is added — asserting each mutator's *first*
  lock call is `claimOrdersInOrder` carrying the correct order-id set, and (for `createShipper`)
  that it precedes `certs.ts`'s transitive `claimOrder` call via `invocationCallOrder`.
- Step 5b: the `updateShipper` audit-content test, asserting `SNAPSHOT_INCLUDE.shipper`'s actual
  payload — customer by code, carrier and ship-to by name, not raw cuids.
- Step 6: two tests hitting `ShipperOrder`'s `@@unique([shipperId, orderId])` and
  `@@unique([shipperId, position])` directly via raw `prisma.shipperOrder.create` calls, the
  second surviving a real two-phase-park renumber first.
- Step 7: the over-ship warning test for `replaceShipperLines`, plus a "does not warn when within
  range" counterpart.
- Various refusal/404/membership tests for each of the six mutators, plus `listShippers`/
  `exportShippers`/`shipmentsForOrder` coverage (filter, search, includeVoided, totals, label
  ordering, export smoke test).

One brief bug fixed rather than reproduced: the Step 1 sample `const { orderA } = await
completeShipmentOf(orderA)` reads `orderA` in its own initializer (a TDZ `ReferenceError` — it
cannot run as written). `completeShipmentOf()` now takes no argument and builds its own order
internally; the test's intent (order starts `SHIPPED`, reverts to `OPEN` after removal) is
unchanged.

## TDD evidence

Given the size and interdependency of this task's design (six mutators sharing several small
helpers), I front-loaded the service implementation to work out the design, then wrote the test
file, then verified genuine RED/GREEN with a stash dance rather than trusting that "the tests
exist and pass" implies they'd have failed first:

```
$ git stash push --keep-index -- src/server/shippers.ts   # revert impl, keep new test file
$ npx vitest run tests/shipper-children.test.ts
 ...
 Test Files  1 failed (1)
      Tests  35 failed | 2 passed (37)
# every new export (updateShipper, addOrderToShipper, removeOrderFromShipper,
# replaceShipperLines/Containers/Serials) reported "TypeError: X is not a function" —
# genuine RED, not a assertion failure inside an already-passing call.

$ git stash pop                                            # restore implementation
$ npx vitest run tests/shipper-children.test.ts
 Test Files  1 passed (1)
      Tests  37 passed (37)
```

(37, not 39 — the two extra tests added during the review-fix round came after this RED/GREEN
check; both pass under the current implementation, see below.)

## Independent review round

Dispatched the `task-reviewer` subagent against the diff (base `4cef461`, head `ef64058`) with the
brief, global constraints and spec sections. Verdict: **Spec compliant**, **Task quality: Needs
fixes** — one Important finding:

> `addOrderToShipper` computed its duplicate-order check and the new `ShipperOrder.position` from
> a `shipperOrder.findMany` read taken *before* `claimOrdersInOrder`, not after it. Two concurrent
> `addOrderToShipper` calls against the same shipment would each read the same pre-claim snapshot
> (Postgres Serializable's ordinary reads reflect the transaction-start snapshot regardless of
> when they're issued, even after unblocking on a `FOR UPDATE` claim), so a real collision would
> land on the raw database unique constraint. `withDbErrors({entity: "Shipper"})` with no
> `conflictField` would then report a generic, mislabelled message — the exact "a refusal naming a
> problem that did not exist" shape the Task 8 review itself flagged, not a correctness bug (the
> constraints prevent silent corruption) but a quality one.

Fixed: the duplicate check (`shipperOrder.findFirst`) and the position number (`MAX(position) + 1`
via `.aggregate`, mirroring `nextShipmentSequence`'s own idiom) now both read fresh *after*
`claimOrdersInOrder`; the pre-claim `shipperOrder.findMany` read survives only to know which
orders to claim in the first place (there is no `Shipper`/`ShipperOrder` row lock to claim
instead — some unlocked read is unavoidable there). Any residual `P2002` — a genuine race the row
lock's shared-order intersection didn't fully prevent — now maps to the same honest "please try
again" 409 a real Serializable conflict gets elsewhere in this codebase, not the generic fallback.

Two Minor findings also addressed:
- `ROW_SELECT.orders` (used by `listShippers`/`exportShippers`/`shipmentsForOrder`) had no
  `orderBy`, so a multi-order shipment's `orderLabels` list wasn't guaranteed to render in print
  order. Added `orderBy: { position: "asc" }` (the `DETAIL_INCLUDE` precedent) and a test that
  exercises a two-order shipment specifically (the prior test suite only ever listed a
  single-order shipment).
- No test exercised `updateShipper` rejecting an unknown `carrierId`. Added one.

One item the reviewer flagged as "cannot verify from diff, may be deliberately deferred": whether
`replaceShipperLines` should re-enforce spec §4.2's "a shipment must carry at least one line with
qty > 0" invariant on an edit that empties a single-order shipment down to nothing. I considered
this and left it unenforced, deliberately: the brief's explicit refusal list for Task 9 does not
mention it, the check would need to aggregate qty across every order on the shipment (not just the
one being edited) to be correct, and the spec explicitly treats a `qty = 0` / `lineComplete = true`
line as a legitimate ongoing state ("we are not sending the last three, close the line") — the
create-time gate exists to stop a document about nothing from being *created*, not to forbid a
document mid-edit from passing through zero. Flagging this for whoever reviews the branch as a
whole, in case the owner disagrees.

Re-ran the full test file, `tsc --noEmit` and `eslint` after the fixes — all clean; then the full
suite once more before the final commit.

## Test results

```
npx vitest run tests/shipper-children.test.ts   → 39/39 passed
npm test                                         → 1210/1210 passed (85 files)
npx tsc --noEmit                                 → clean
npx eslint src tests                             → clean
```

## Files changed

- `/home/cojoa13/Desktop/HeatSynQ/erp/src/server/shippers.ts` — six mutators, `overshipWarnings`,
  `listShippers`/`exportShippers`/`shipmentsForOrder`, `ShipperFilter`/`ShipperRow`, and the small
  shared helpers (`claimLiveShipper`, `findShipperOrder`, `shipperOrderIds`,
  `renumberShipperOrderPositions`).
- `/home/cojoa13/Desktop/HeatSynQ/erp/tests/shipper-children.test.ts` — new, 39 tests.

Commits on `phase-4-certs-shipping`:
- `ef64058` — `feat(shipping): shipment children, add/remove order, listing and export`
- `8c0d914` — `fix(shipping): claim before reading addOrderToShipper's position/duplicate state`

## Self-review against the brief and spec §4.2/§5.2/§5.3/§5.5

- All nine "Produces" signatures match the brief verbatim (names, parameter order, return types).
- §5.3's claim discipline: every mutator's first lock call is `claimOrdersInOrder` with the full
  affected-order set — verified by the composition tests, not just asserted in a comment.
- §5.5's printed-ticket refusal: implemented exactly as specified, including the whole-set-print
  covering every order on the shipment.
- §5.2's status recompute: called uniformly after every mutator, including ones (header patch,
  container/serial replace) where it is a structural no-op — matching the codebase's own
  established "call it uniformly so no mutator silently depends on an invariant" philosophy.
- Naming: no new terms invented beyond the brief's; `overshipWarnings` is documented inline as to
  why it exists and what it's for.
- YAGNI: did not add route handlers, permission wiring, or a warnings-wrapper return type beyond
  what the brief specifies — those are Tasks 10/11's job.
- Test quality: every refusal test asserts on the SERVICE's own message (never a raw DB error
  leaking through), and the one place a raw DB error legitimately could leak through
  (`addOrderToShipper`'s residual race) now gets an honest, consistent message rather than a
  misleading one.
- Output is pristine — no console noise, no skipped tests, no `.only`/`.skip` left behind.

## Concerns

- The `overshipWarnings` design decision (above) is a genuine interpretation call on an ambiguous
  brief instruction, not something I could resolve with certainty. I believe it is the more
  defensible reading given the brief's explicit "use its exact... code verbatim" instruction for
  the six signatures, and the independent reviewer agreed, but it is worth the owner's or a
  whole-branch reviewer's eyes before Task 11 builds routes on top of it.
- The zero-qty-on-edit question (above) is a plausible, deliberately-declined scope boundary — flag
  it if the owner wants shipment-edit invariants tightened beyond what the brief specified.

## Addendum: coordinator review round — §4.2's non-empty-shipment invariant

The "zero-qty-on-edit" item flagged above as a "deliberately-declined scope boundary" was
re-examined by the coordinator against the independent review and found to be a real gap, with a
starker case than the one I'd disclosed: I had only flagged `replaceShipperLines` zeroing a
single order's lines. The reviewer found that **`removeOrderFromShipper` could remove a
shipment's LAST remaining order**, leaving a `Shipper` row with `orders: []` — the literal
"document about nothing" spec §4.2 forbids ("a shipment must carry at least one line with `qty >
0` across all its orders (service-enforced)") — and my own test at the time
(`tests/shipper-children.test.ts`, the one-order `completeShipmentOf()` fixture) exercised exactly
that path and passed with no refusal, because it never asked whether the resulting state was
itself legal.

My earlier reasoning ("the create-time gate exists to stop a document about nothing from being
*created*, not to forbid a document mid-edit from passing through zero") was wrong as a general
rule: it's defensible for a single line staying zero (`qty = 0`/`lineComplete = true` is
explicitly legal on its own — "close the line"), but the invariant is about the SHIPMENT AS A
WHOLE, and nothing enforces that once the document exists. Fixed both reachable paths:

- **`removeOrderFromShipper`** now refuses removing the shipment's last order
  (`src/server/shippers.ts`), naming the real remedy — void the shipment (§5.6), which is the
  correction that keeps every `ShipperOrder.sequence` claimed forever, the same shape the
  printed-ticket refusal right below it already uses.
- **`replaceShipperLines`** now refuses an edit that would leave the WHOLE shipment — every line,
  across every `ShipperOrder`, not just the one being edited — with no `qty > 0` line. Checked only
  when this order's own new lines carry none (the common case, this order still ships something,
  costs nothing extra); when it does, one extra read checks every OTHER `ShipperOrder` on the same
  shipment for a live positive-qty line before refusing.

`completeShipmentOf()` (the shared test fixture for "recomputes status when an order is removed")
is now a two-order shipment — order A (whose line is marked `lineComplete`, driving it to
`SHIPPED`) plus a spare order B that stays on the shipment throughout — so removing order A's
`ShipperOrder` is never the shipment's last-order removal, and the test still proves what it was
written to prove (status recompute on removal) rather than accidentally exercising the newly
forbidden state.

Also fixed the stale attribution in `src/server/audit.ts` (~line 136): the comment on
`SNAPSHOT_INCLUDE.shipper` credited `removeOrderFromShipper` to "Task 10" — this task implements
it, not Task 10 (which owns `voidShipper`). Reworded the same comment to note that an order-less
shipment is no longer actually reachable through that path (the new refusal above), while keeping
the direct `customer`/`carrier`/`shipToAddress` selects as cheap defensive insurance regardless.

New tests added (all verified genuinely RED first — each new guard was temporarily short-circuited
with `if (false && …)`, the corresponding test failed with the real assertion message shown above,
then the guard was restored and the test went green):

- `removeOrderFromShipper` refuses to remove the shipment's last remaining order (message matches
  `/void the shipment/i`).
- `removeOrderFromShipper` still allows removing an order that is NOT the last one.
- `replaceShipperLines` refuses zeroing a shipment's only line across all its orders (message
  matches `/at least one line/i`).
- `replaceShipperLines` still allows zeroing one order's lines when another order on the same
  shipment retains a positive-qty line.

### Re-run test results

```
npx vitest run tests/shipper-children.test.ts tests/shippers.test.ts   → 63/63 passed
                                                                           (43 + 20)
npm test                                                                → 1214/1214 passed (85 files)
npx tsc --noEmit                                                        → clean
npx eslint src tests                                                    → clean
```

### Not addressed here (explicitly out of scope, per the coordinator)

- The `overshipWarnings` seam (Task 11 now wraps every mutating shipment route in a `{shipper,
  warnings}` shape to make sure a route can't silently drop it) — my signatures are unchanged.
- `ship-ledger.ts:56`'s "Task 8's shipment create/void" comment is about the order-status recompute
  hook, a different rule from the §4.2 non-empty-shipment invariant this addendum covers — left
  as-is, confirmed not in scope.

### Commits

- `ef64058` — `feat(shipping): shipment children, add/remove order, listing and export`
- `8c0d914` — `fix(shipping): claim before reading addOrderToShipper's position/duplicate state`
- `95d9d7d` — `fix(shipping): enforce the non-empty-shipment invariant on every edit path`
