# Task 13 report — `invoices.ts` finalize, unlock, and status ownership

## What I implemented

Lifecycle transitions on the invoice, and the `INVOICED`/`REOPENED` status ownership between the
invoice and its order.

### `src/server/ship-ledger.ts`
- New module const `INVOICE_OWNED: OrderStatus[] = ["INVOICED", "REOPENED"]` with the §5.2 reasoning
  comment.
- `recomputeOrderStatus` gains the invoice-owned skip beside its existing voided-order skip:
  `if (INVOICE_OWNED.includes(order.status) && !releasedSet.has(order.id)) continue;`
- Signature gains an optional third arg `released: string[] = []` — **unlock's escape hatch**. This
  is the reconciliation of the two prescriptive tests (see "Design decision" below): a shipment-side
  recompute (no `released`) still leaves every invoice-owned order alone, but unlock passes the one
  order it is releasing so recompute settles it on its ship-derived value instead of skipping it
  `INVOICED` forever. All existing callers (orders.ts, shippers.ts, both `recomputeOrderStatus` call
  sites in tests) use the 2-arg form and are unaffected.

### `src/server/invoices.ts`
- Extracted **`claimInvoiceRow`** (order claim via `claimOrder` → `FOR UPDATE` on the Invoice row →
  liveness re-read), the claim now shared by every lifecycle mutator. `claimLiveInvoice` (Task 12's
  edit-mutator claim) is refactored to `claimInvoiceRow` + the FINALIZED refusal — behaviour and
  message unchanged. This is why finalize and unlock take the **same** order claim, first, that
  Task 10's guards depend on.
- **`finalizeInvoice(id, tx?)`** — `finalizeInvoiceInTx` under the shared claim: refuse a voided
  order (`/voided/`), refuse an already-FINALIZED invoice (`"That invoice is already finalized"`,
  never a second write), refuse while any line still has `needsPrice` (naming the first offending
  line, `… needs a price …`). Then one `auditedUpdate("invoice", …)` stamping `status=FINALIZED`,
  `finalizedAt`, `finalizedById` (from `currentActor()`), and one `auditedUpdate("order", …)` to
  `INVOICED`. It re-prices nothing — it freezes the current lines. No GL check (spec §15 → export).
  `tx?` mirrors `createInvoice` so the concurrency test can drive it at Read Committed.
- **`unlockInvoice(id, reason)`** — reason required and trimmed in the service; under the shared
  claim, refuse a non-FINALIZED invoice, then one `auditedUpdate("invoice", …, { tx, reason })`
  clearing `status`→`DRAFT`/`finalizedAt`/`finalizedById`, **then** `recomputeOrderStatus(tx,
  [orderId], [orderId])`. Clear first, recompute second.

## Design decision — the recompute skip vs. unlock (resolved from the prescriptive tests)

The two Step-1 tests constrain each other. `tests/ship-ledger.test.ts` "leaves an INVOICED order
alone" sets `status=INVOICED` with **no invoice present** and expects it preserved → the skip must be
**`order.status`-based** (an invoice-existence-based skip fails this test). The `unlockInvoice` test
needs `INVOICED → SHIPPED` via `recomputeOrderStatus`. Those reconcile only if unlock can lift the
skip for the one order it is handing back — hence the `released` param. This keeps
`recomputeOrderStatus` the single status authority (no duplicated derivation, no hard-coded reset
value, one clean audit entry `INVOICED→SHIPPED`), and makes the brief's step-5 sentence literally
true ("the skip only fires while the order is still in an invoice-owned state" — i.e. one it is not
being released from). The brief's step-3 skip snippet is preserved verbatim except for the
`&& !releasedSet.has(order.id)` carve-out that step 5 requires.

## TDD evidence

**RED — ship-ledger** (before the skip existed):
```
FAIL  recomputeOrderStatus — invoice-owned states > leaves an INVOICED order alone
  AssertionError: expected 'SHIPPED' to be 'INVOICED'
FAIL  recomputeOrderStatus — invoice-owned states > leaves a REOPENED order alone
  AssertionError: expected 'SHIPPED' to be 'REOPENED'
```

**RED — invoices** (before finalize/unlock existed): the suite failed to run finalize/unlock cases
(`finalizeInvoice`/`unlockInvoice` undefined → the choreographed holder tx left a hook timing out);
`8 failed | 1 passed` across the new cases.

**GREEN — both focused files after implementing:**
```
✓ tests/invoices.test.ts (39 tests) 3489ms
✓ tests/ship-ledger.test.ts (18 tests) 962ms
Test Files  2 passed (2)   Tests  57 passed (57)
```

**Concurrency test is a genuine RED/GREEN on the order claim.** With `claimOrder` in `claimInvoiceRow`
temporarily swapped for a plain unlocked `findFirst`:
```
FAIL  finalizeInvoice > reads the order under the claim …
  expected finalizeCall to reject with /voided/i, but it RESOLVED (returned a FINALIZED invoice,
  total 937.44) — i.e. it finalized a voided order
```
Restored → passes. The competing caller runs at Read Committed (manual tx), so only `claimOrder`'s
row lock — not SSI — can order the two: the holder claims the order row and voids it, and WITH the
claim finalize blocks on that row then reads the freshly-voided state and refuses; WITHOUT it,
finalize reads a stale unlocked snapshot, sails past the guard, and finalizes a voided order.

## How the folded-in requirements are met

1. **Finalize/unlock claim the order before flipping invoice state.** Both go through
   `claimInvoiceRow`, whose first act is `claimOrder(tx, orderId)` (order row), then `FOR UPDATE` on
   the Invoice row — the exact discipline `claimLiveInvoice` uses. The concurrency test above proves
   finalize reads the order under that claim (RED with the claim removed). Unlock shares the same
   helper.
2. **Unlock returns status to `DRAFT`.** Proved directly by "returns the invoice to DRAFT — every
   draft edit works again": after `finalizeInvoice`, `updateInvoice` is refused (`/finalized/`);
   after `unlockInvoice`, all four Task-12 mutators (`updateInvoice`, `replaceInvoiceLines`,
   `recalculateInvoice`, `discardInvoice`) succeed again.

## Other spec points verified by tests
- **needsPrice blocks finalize** — "refuses to finalize while a line needs a price" (fixture
  `priced:false`). Uses the resolved-price `needsPrice` (Task 9); a step code with no GL account does
  **not** block ("finalizes with a step code that has no GL account").
- **Finalize freezes, never re-prices** — "freezes the current lines": an operation line edited to
  $1 stays $1 after finalize (a re-price would restore $937.44).
- **Idempotent finalize** — "finalizing twice is a 400, never a second write": unchanged
  `finalizedAt`, exactly one FINALIZED audit entry.
- **Audit content** — finalize's invoice entry diffs `status` DRAFT→FINALIZED and its order entry
  SHIPPED→INVOICED; unlock's invoice entry carries the trimmed reason.
- **Status ownership** — `recomputeOrderStatus` leaves INVOICED and REOPENED orders alone (both
  ship-ledger tests), and recomputes a released order.

## Files changed
- `src/server/invoices.ts` — `claimInvoiceRow` extraction, `finalizeInvoice`, `unlockInvoice`.
- `src/server/ship-ledger.ts` — `INVOICE_OWNED`, the skip, the `released` param.
- `tests/invoices.test.ts` — extended `draftFixture` (`priced`/`glAccount`), finalize + unlock suites.
- `tests/ship-ledger.test.ts` — `shippedOrder` helper, invoice-owned-state suite.

## Self-review
- Completeness: finalize, unlock, status ownership, all Step-1 tests plus audit-content, freeze,
  idempotency, DRAFT-restore, and a discriminating concurrency test.
- Discipline: every mutation through `audited*` with `tx`; no new audit exceptions; claims before
  reads/writes; no `findUnique`/`upsert` on partial-unique columns; refusals name their blocker.
- Would each test fail on regression? Yes — verified the concurrency test RED (claim removed) and the
  ship-ledger tests RED (skip absent); the DRAFT-restore test fails if unlock leaves FINALIZED; the
  freeze test fails if finalize re-prices; the needsPrice test fails if the block is dropped.

## Concerns
- **Finalize's order claim cannot be discriminated by a "does it block" test** because finalize also
  writes `Order.status` (which serializes order-touching competitors anyway) and locks the Invoice
  row (which serializes invoice-touching competitors). I made the concurrency test discriminate on
  **outcome** instead, via finalize reading the order's voided state under the claim — which required
  adding a voided-order refusal to finalize. That refusal is consistent with `createInvoice` and
  `recalculateInvoice` (both already refuse `order.deletedAt`) and upholds §5.7 (a voided+finalized
  order should never coexist); it is a small, defensible addition beyond the brief's enumerated steps,
  taken specifically to satisfy note #1's "prove finalize takes the claim" requirement.
- `unlockInvoice` has no `tx?` param (the brief's interface is `unlockInvoice(id, reason)`); its order
  claim is the same `claimInvoiceRow` the finalize concurrency test exercises, so it is covered
  structurally rather than by a second choreographed test.
