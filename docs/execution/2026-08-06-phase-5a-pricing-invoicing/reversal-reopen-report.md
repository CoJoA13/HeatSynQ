# Reversal-reopen — a reversing shipment reopens the order it reverses

Owner ruling 2026-08-07. Phase 5A, branch `phase-5a-pricing-invoicing`.

## The ruling

A reversing shipment (Task 15, `reverseShipper`) pulled quantity back with negative lines but did
**not** clear the completion flag on the shipment it reversed — so a reversed order wrongly stayed
`SHIPPED`. The owner needs it to reopen so the corrected quantity can be re-shipped and a corrected
ship ticket printed. Order status is flag-derived (spec §5.2 — `ShipperLine.lineComplete`, never raw
quantity); the fix must keep that rule intact.

## Mechanism (verified against the code)

`recomputeOrderStatus` (`src/server/ship-ledger.ts`) derives `OPEN`/`PARTIAL_SHIPPED`/`SHIPPED` from
whether each order line has a **live shipper line marked `lineComplete`**. It is correct and was
**not** changed. The bug lived upstream: after a reversal, the ORIGINAL shipment's lines still
carried `lineComplete = true`, so every order line stayed "complete" and the recompute re-derived
`SHIPPED`. The reversal's own negated lines are `lineComplete: false` and never contributed to the
"complete" set.

The fix, in `reverseShipperInTx` (`src/server/shippers.ts`), is a new **step 6b**, inserted after
the reversal is created and before the step-7 status handling:

- Collect the ids of the ORIGINAL shipment's lines that are currently `lineComplete` (from
  `original.orders[].lines[]`, already read under the claim in step 3).
- If any, clear them via `auditedUpdate("shipper", original.id, () => tx.shipperLine.updateMany({
  where: { id: { in: completeLineIds } }, data: { lineComplete: false } }), { tx, reason: why })`.

This touches the **flag**, not the derivation rule, and never brings net quantity into the status
decision. It runs UNDER the existing claim (Task 15's `claimOrdersInOrder` + `claimShipperRow` on the
original), inside the same transaction, through the audited path onto the original shipment's own
history. No second claim, no differently-ordered claim. The conditional guard means a reversal of a
never-completed partial shipment writes no no-op audit entry (recompute's own discipline).

Both status paths below it then reopen correctly:

- **Non-invoiced order** — left to `recomputeOrderStatus`'s two-arg form (unchanged). With the flag
  cleared it derives `PARTIAL_SHIPPED` (the reversal document is itself a live shipment, so never
  `OPEN`).
- **Invoiced order** — still writes `REOPENED` **directly**, and still never passes `released` to
  `recomputeOrderStatus` (that arg is unlock-only; the whole-branch review's invariant is preserved).
  Because the flag is now cleared, a later **unlock** — which calls
  `recomputeOrderStatus(tx, [order.id], [order.id])` — derives `PARTIAL_SHIPPED` instead of
  re-closing the order to `SHIPPED`.

## TDD

RED captured first, against the pre-change code (`npx vitest run tests/shipper-reverse.test.ts`):

```
FAIL  reopens a non-invoiced order to its ship-derived PARTIAL_SHIPPED, never REOPENED
      expected 'SHIPPED' to be 'PARTIAL_SHIPPED'
FAIL  1000-pc workflow: a reversal reopens the order to PARTIAL_SHIPPED (owner ruling 2026-08-07)
      expected 'SHIPPED' to be 'PARTIAL_SHIPPED'   (step 3 — reverse shipment 2)
FAIL  invoiced -> reverse (REOPENED) -> unlock derives PARTIAL_SHIPPED, not SHIPPED
      expected 'SHIPPED' to be 'PARTIAL_SHIPPED'
Tests  3 failed | 11 passed (14)
```

GREEN after the fix: `tests/shipper-reverse.test.ts` — 14 passed.

### Tests added / changed (`tests/shipper-reverse.test.ts`)

1. **1000-pc workflow** — walks the owner's five steps EXACTLY: ship 350 not complete
   (`PARTIAL_SHIPPED`) → ship 650 complete (`SHIPPED`) → reverse shipment 2 (`PARTIAL_SHIPPED`, ledger
   nets to 350) → ship corrected 463 not complete (`PARTIAL_SHIPPED`) → ship 187 complete
   (`SHIPPED`, ledger 1000). The load breakdown (100/100/100/50) is packaging detail; status is
   flag-derived, so each step ships the aggregate qty and toggles the flag. RED before at step 3.
2. **invoiced → reverse → unlock** — invoice → finalize (`INVOICED`) → reverse (`REOPENED`) →
   unlock → order derives `PARTIAL_SHIPPED`, not `SHIPPED`.
3. **simple full-single-shipment reversal** — repurposed the existing "leaves a non-invoiced order at
   SHIPPED" test (whose comment argued SHIPPED was correct — that reasoning is exactly what the ruling
   repeals) to assert `PARTIAL_SHIPPED`, and confirms the order is still passed to
   `recomputeOrderStatus` with an empty `released` set (proven derived, not forced).

The existing invoiced-path tests still hold: `REOPENED` is written directly, `released` stays `[]`
from the shipment path, and the REOPENED audit entry still carries the reason. A new `shipInput`
helper (explicit qty/weight/lineComplete) and a `invoiceId` return on `invoicedFixture` support the
new tests.

## Spec update

`docs/superpowers/specs/2026-08-06-phase-5a-pricing-invoicing-design.md`:

- **§5.2** — added a paragraph: a reversing shipment clears `lineComplete` on the lines it reverses,
  status stays flag-derived, non-invoiced reopens to `PARTIAL_SHIPPED`, invoiced keeps its direct
  `REOPENED` write but a later unlock derives `PARTIAL_SHIPPED`. Cites owner ruling 2026-08-07.
- **§5.6** — added a paragraph on the reversing shipment stating the same, under the claim, keeping
  `recomputeOrderStatus`'s rule untouched.

## Gates (all green)

| Gate | Result |
|------|--------|
| `npx vitest run tests/shipper-reverse.test.ts tests/ship-ledger.test.ts tests/invoices.test.ts tests/shipper-routes.test.ts` | pass |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint src tests` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` (full) | 1692 passed, 109 files |
| `npm run test:e2e` | 16/16 flows pass, incl. `invoice-shipped-order` (finalize/unlock) |

## Constraints honoured

- Clear runs under the EXISTING claim, in the same transaction, through `auditedUpdate` with `tx`. No
  second claim, no differently-ordered claim.
- `recomputeOrderStatus`'s derivation rule unchanged; raw net quantity never enters the status
  decision.
- `released` remains unlock-only — the shipment path never passes it.
- The below-zero reversal guard and everything else Task 15 built is untouched.

## Files changed

- `erp/src/server/shippers.ts` — step 6b in `reverseShipperInTx`.
- `erp/tests/shipper-reverse.test.ts` — 2 new tests, 1 repurposed, `shipInput` helper, `invoicedFixture` returns `invoiceId`.
- `docs/superpowers/specs/2026-08-06-phase-5a-pricing-invoicing-design.md` — §5.2 and §5.6 (spec file, committed; execution docs are NOT committed).
