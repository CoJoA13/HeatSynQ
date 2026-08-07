# Task 15 — The reversing shipment — report

**Status: DONE_WITH_CONCERNS** (one deliberate deviation from the brief's illustrative test,
resolved against the binding spec — see Concerns).

## What I implemented

A reversing shipment: `reverseShipper(id, input, tx?)` in `src/server/shippers.ts`, the route
`POST /api/shippers/[id]/reverse`, and the `reversesShipperId` field on `ShipperDetail`.

A reversal is a new `Shipper` with `reversesShipperId` set, whose lines are the **negation** of the
original shipment's qty/weight (`lineComplete: false`). `shippedTotals` already sums `qty`, so the
negatives net the ledger down with no change to `ship-ledger.ts` (see "Netting" and "Files"). Ship
date defaults to the original's; a reason is required and trimmed in the service and rides the audit
entry. It allocates its own packing-list number and, per order, its own never-reused shipment
`sequence`.

## TDD evidence (RED → GREEN)

**RED** — `tests/shipper-reverse.test.ts` written first, run before implementation:
```
Test Files  1 failed (1)
     Tests  11 failed | 1 passed (12)
```
(The 1 pass is the leak-guard test — `createShipper` already refuses a negative qty. The other 11
fail because `reverseShipper` did not yet exist.)

**GREEN** — after implementing `reverseShipper` + route + `ShipperDetail.reversesShipperId`:
```
tests/shipper-reverse.test.ts (12 tests)  → 12 passed
tests/shipper-routes.test.ts  (+1 test)   → 26 passed (both files)
```

**Concurrency test is discriminating (RED with the claim removed).** I temporarily replaced
`claimOrdersInOrder(tx, orderIds)` with an unlocked `tx.order.findMany(...)` and reran only
"reads order state under the claim …":
```
Tests  1 failed | 11 skipped (12)
  AssertionError: expected [reverseCall] to reject with /voided/i — it resolved (returned a shipper)
```
With the real claim restored it is GREEN. This proves the row lock — not SSI — is what makes the
voided-order refusal correct: the competing "holder" runs at Read Committed (a manually-opened tx),
the reversal is invoked with that isolation via the optional `tx` param (the `finalizeInvoice`
precedent), so only `claimOrdersInOrder`'s `FOR UPDATE` can order the two.

## How it reuses voidShipper's / saveNewShipper's machinery (not a second path)

`reverseShipperInTx` opens `withDbErrors` → Serializable `$transaction` and then reuses the exact
shared primitives every shipment mutator uses:

- **the claim**: `claimOrdersInOrder(tx, orderIds)` — one sorted `FOR UPDATE` statement, never a
  per-row loop — followed by `claimShipperRow(tx, id)` (the order-locks house rule: the guarded
  state `Shipper.deletedAt`/`reversesShipperId` lives on the Shipper row, so it is locked with the
  claim, uniformly after the order claims).
- **the recompute**: `recomputeOrderStatus(tx, deriveIds)` for the non-invoiced orders.
- `finalizedInvoicesFor` (Task 10 guard, read under the claim), `shippedTotals`,
  `nextShipmentSequence`, `allocateNumber`, `auditedCreate`, `auditedUpdate`, `readShipperDetail`,
  `shipmentWarnings`.

No new locking path, no second void/dangerous action.

## REOPENED is written DIRECTLY — `released` is never passed from this path

After the write: `reopenedIds = finalizedInvoicesFor(tx, orderIds)`. Every order in that set gets
`Order.status = REOPENED` **written directly** via `auditedUpdate("order", …, { tx, reason })`. Every
other order is handed to `recomputeOrderStatus(tx, deriveIds)` — the **two-arg** form, exactly like
all eight existing shippers.ts sites. `released` (the third arg) is never passed from here; it is
unlock's escape hatch alone (`invoices.ts`), and passing it from a shipment path is the hole the
invoice-owned skip exists to close.

Proven at the seam: the test wraps `recomputeOrderStatus` at the module boundary
(`vi.fn(actual.fn)`, never a Prisma-delegate spy) and asserts, for the invoiced order, that the id
appears in **neither** `recompute`'s target arg (`c[1]`) nor its `released` arg (`c[2]`), while the
order ends at REOPENED — so REOPENED can only have come from the direct write. It also asserts the
order's audit entry is `INVOICED → REOPENED` carrying the reason.

## Netting, the below-zero guard, and the over-ship warning

- **Netting**: the negated lines carry the same `orderLineId` as the original's, so `shippedTotals`
  sums `+100 + (−100) = 0`. Test asserts `totals.get(lineId).qty === 0` after a full reversal.
- **Below zero (spec §5.6)**: before writing, `netBefore = shippedTotals(tx, orderLineIds)` read
  under the claim; for each line, refuse if `netBefore.qty − originalQty < 0` (weight compared in
  integer cents). A second reversal of the same shipment (ledger already at 0) is refused with
  `/below zero/`.
- **Over-ship warning**: no `ship-ledger.ts` change was needed. The warning nets automatically —
  `shipmentWarnings`/`overshipWarnings` compare `shippedToDateQty > orderedQty`, and a reversal only
  drives shipped-to-date **down**, so it can never exceed ordered. `saveNewShipper`'s own loop
  likewise compares against `priorShipped` and a negative line can never trip `l.qty > remaining`.
  Test asserts the reversal's warnings never match `/exceeds the/i`. (The brief's "Files" list names
  `ship-ledger.ts (over-ship warning against the net total)`; on inspection the netting is already
  provided by `shippedTotals`, and Step 4 confirms the existing check already handles it — so no
  ship-ledger.ts edit was required.)

## Claim discipline

`claimOrdersInOrder` (deduped, ascending, one statement) then `claimShipperRow`. All guarded state
— voided-original check, reversal-of-reversal check, voided-order check, the below-zero ledger read,
and the finalized-invoice read — happens **after** the claim, on the claim-held `tx`. Serializable
on the public path; the FK-writer pattern is untouched (no new registered-FK writes beyond the
copied header, which points only at rows the original already validated).

## Files changed

- `src/server/shippers.ts` — `reverseShipper`/`reverseShipperInTx`, `REVERSE_SHIPPER` schema,
  `reverseAuditPayload`, `ShipperDetail.reversesShipperId` + `toDetail` mapping.
- `src/app/api/shippers/[id]/reverse/route.ts` — new; `mustDo(requireUser(), "void_shipper")`,
  body `{ reason, shipDate? }`, returns `shipperResponse(...)`.
- `tests/shipper-reverse.test.ts` — new; 12 tests.
- `tests/shipper-routes.test.ts` — +1 route-permission test.

No schema/migration change (`reversesShipperId` landed in Task 2). No `ship-ledger.ts` change (see
above).

## Gates

| Gate | Result |
|---|---|
| `npm test` | ✅ 107 files, 1654 tests |
| `npx tsc --noEmit` | ✅ |
| `npx eslint src tests` | ✅ |
| `npm run build` | ✅ (route `/api/shippers/[id]/reverse` registered) |
| `npm run test:e2e` | ⏭️ skipped — the route is the only new surface and no page is wired to it, so there is no flow to exercise (per the brief). |

## Self-review

- Does a test prove REOPENED is written directly (and `released` is NOT passed)? **Yes** — the
  seam test asserts the invoiced order never reaches `recomputeOrderStatus` (neither arg) yet ends
  REOPENED, and `allReleased` is always `[]`.
- Does a test prove the net shipped total drops correctly? **Yes** — netting test (→ 0) and the
  below-zero test (second reversal refused).
- Does a test prove the claim serializes (RED with the claim removed)? **Yes** — verified RED by
  removing the claim (transcript above), GREEN with it.
- Would each test fail if the behavior regressed? Reviewed each; the seam and concurrency tests are
  the two that guard the dangerous invariants and both go RED under the corresponding regression.

## Concerns

1. **The brief's illustrative test expects `OPEN` for the non-invoiced case; I implemented and
   tested the spec-correct `SHIPPED` (derived), and flag it here.** Spec §5.2 (binding) says
   OPEN/PARTIAL_SHIPPED/SHIPPED stay ship-derived from the human line-complete flags —
   "quantities never enter this decision" (`ship-ledger.ts`). After a reversal the original line is
   still live **and** still line-complete, and the reversal adds another live line, so
   `recomputeOrderStatus` always sees `anyLive = true` and (with a complete original) derives
   `SHIPPED`. `OPEN` is **unreachable** through recompute for a reversed order — the brief's `OPEN`
   was a net-quantity intuition the spec explicitly rejects. I followed CLAUDE.md's "the spec is
   binding" and the task's "read the spec; do not assume", implemented `recomputeOrderStatus`
   two-arg (derived), and wrote the test to assert `SHIPPED` (and `not REOPENED`), with a comment
   explaining the deviation. If the owner actually wants a fully-reversed order to fall to `OPEN`,
   that is a change to the status-derivation rule (quantities entering it) and should be an explicit
   spec amendment, not smuggled in through the reversal path.

2. **Reversal header scope.** The reversal copies the original's `customerId`, `shipToAddressId`,
   `carrierId`, `route`, `comments` and (defaulted) ship date, but deliberately does **not** copy
   freight (`billFreight`/`freightAmount` stay at defaults) or create any cert. The spec pins only
   "negative qty/weight lines + `reversesShipperId` + ship-date default + reason"; copying freight
   onto a reversal risked interacting with invoice freight, and a reversal is a correction, not a
   new shipment needing a cert. Containers/serials are not copied (a reversal is about the ledger,
   not packaging). Flagging in case the reviewer wants freight/containers mirrored.

3. **Voided-original / reversal-of-reversal.** Not covered by the brief's tests or the spec, but I
   refuse both (404 a voided original; 400 a reversal-of-reversal) to prevent netting a *different*
   live shipment's quantity and to avoid driving the ledger up. Conservative; called out for review.
