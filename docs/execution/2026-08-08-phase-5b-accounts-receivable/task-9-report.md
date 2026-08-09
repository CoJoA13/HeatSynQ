# Task 9 report — `invoice-guards` A/R-activity + the unlock / discard / void-order refusals

**Status:** Complete. All four gates plus the full E2E suite green. Concurrency test verified RED then GREEN.

## What was built

`hasReceivableActivity(tx, invoiceId)` in the dependency-free leaf `src/server/invoice-guards.ts`, and
three call-site refusals that read it under the claim each mutator already holds:

- `unlockInvoice` (invoices.ts) — the primary, reachable guard.
- `voidOrder` (orders.ts) — the primary, reachable guard (an order whose invoice was paid).
- `discardInvoice` (invoices.ts) — defense-in-depth, unreachable through the services (see below).

## `hasReceivableActivity` — the query

A single existence query on the caller's own `tx`, importing only `type Prisma` (the leaf stays a
leaf):

```ts
export async function hasReceivableActivity(
  tx: Prisma.TransactionClient, invoiceId: string,
): Promise<boolean> {
  const row = await tx.application.findFirst({
    where: { deletedAt: null, OR: [{ invoiceId }, { creditInvoiceId: invoiceId }] },
    select: { id: true },
  });
  return !!row;
}
```

Two arms because an `Application` touches an invoice from both sides: `invoiceId = this` (a
payment/discount/write-off, or an applied credit's target line, reducing this invoice's open balance)
and `creditInvoiceId = this` (this row is a CREDIT that has been applied against some invoice, so it
is active paper of its own — §4.2's balance rule reads a credit's remaining off exactly these rows). A
voided (soft-deleted) `Application` drops out of both arms, so voiding the application genuinely
re-permits every mutation. `select: { id }` + boolean is the whole contract — the guard cares only
*whether* live activity exists, never how much or what type.

## The three call-site guards

1. **`unlockInvoiceInTx` (invoices.ts).** After the `FINALIZED` check, before the status write:
   ```
   Invoice #<orderNumber> has payments applied — void them before unlocking
   ```
   Read under `claimInvoiceRow`'s order-claim + invoice-row `FOR UPDATE`. `unlockInvoice` was
   refactored to an `unlockInvoiceInTx(tx, id, why)` core + a public `unlockInvoice(id, reason, tx?)`
   wrapper — the exact `finalizeInvoice` shape — so the concurrency test can pass a manually-opened
   Read-Committed transaction. The public no-`tx` path still runs Serializable.

2. **`voidOrder` (orders.ts).** Inserted BEFORE the pre-existing finalized-invoice refusal, so the
   stronger message wins:
   ```
   This order cannot be voided — an invoice on this order has A/R activity; void the payments or credits applied to it first
   ```
   Read under the order claim `claimOrder(tx, id)` — the same claim `applyPayment`/`applyCredit` take,
   so the check and the void it guards serialize through it. Ordering rationale: you cannot unlock or
   credit an invoice while a payment sits on it (unlock's own guard refuses that too), so the only fix
   that works is to void the application — naming A/R activity first points at it. Once the A/R is
   cleared, the pre-existing finalized-invoice guard takes over; unlocking the invoice then re-permits
   the void.

3. **`discardInvoice` (invoices.ts).** After `claimLiveInvoice`, before the printed-doc check:
   ```
   This invoice has payments or credits applied and cannot be discarded — void them first
   ```
   Read under `claimLiveInvoice`'s claim.

No new lock is taken anywhere; every guard reads within the claim its mutator already holds. The
brief's exact message texts are used verbatim for unlock and voidOrder; discard's text (not pinned by
the brief) is written parallel to unlock's and asserted by its own test.

## The `discardInvoice` defense-in-depth test

`discardInvoice` only ever discards a DRAFT, and `applyPayment`/`applyCredit` require FINALIZED
invoices/credits, so **a DRAFT can never carry real A/R activity through the services** — the guard's
triggering state is unreachable by construction (spec §5.3 mandates it belt-and-suspenders). I used
the brief's option (a) to prove the guard is *wired*: raw-insert an `Application` whose
`creditInvoiceId` names a DRAFT credit's id (the FK only needs an `Invoice` row, and
`Application_source_check` does not verify finalized status, so the DB accepts it), then assert
`discardInvoice` refuses and the draft is still live. The test comment documents that this path is
unreachable via the service layer.

## The concurrency test (tests/unlock-concurrency.test.ts)

Modelled on `tests/applications-concurrency.test.ts`. A payment application races an unlock of the
SAME finalized invoice; they must never both commit (an invoice unlocked to DRAFT with a live
`Application` still against it is exactly the state the guard forbids).

- **Holder:** DEFAULT (Read Committed) transaction taking ONLY the invoice-row `FOR UPDATE` claim
  (deliberately not the order lock), writing a 700 PAYMENT `Application`, then holding it uncommitted.
- **Competitor:** `unlockInvoice(id, reason, tx)` on a manually-opened Read-Committed transaction — so
  SSI is out of the picture and the invoice-row claim is the only thing that can serialize it (Phase 4
  lesson 1 / global-constraints).
- The competitor blocks on the invoice lock (proved by a 200 ms race → TIMED_OUT), then after the
  holder commits, its fresh read sees the live application and refuses; the invoice stays FINALIZED
  and exactly one application is live.

**RED verification (transcript evidence):** commenting out the `hasReceivableActivity` guard in
`unlockInvoiceInTx` made the competitor acquire the invoice lock after the holder committed, re-read
the invoice as still FINALIZED, find no guard, and unlock to DRAFT — the returned object showed
`"status": "DRAFT"` while the holder's application stayed live, so `.rejects` failed (`1 failed`).
Restoring the guard → `1 passed`. Both runs were executed in this session.

## TDD RED/GREEN per test

- `hasReceivableActivity` unit tests (invoice-guards.test.ts): written with the leaf function present;
  passed immediately (3 cases — invoiceId arm true→voided-false, creditInvoiceId arm, cross-invoice
  scoping).
- Behavioral RED: with the leaf function present but the three guards NOT yet wired, the unlock
  (invoices.test.ts), discard (invoices.test.ts) and voidOrder (orders.test.ts) tests all failed —
  `3 failed | 205 passed` across the three files (unlock succeeded returning a DRAFT invoice; discard
  succeeded; voidOrder returned the finalized-invoice message, not the A/R one).
- Behavioral GREEN: after wiring the three guards, the same three files → `208 passed`.
- Concurrency RED→GREEN as above.

## Gate results

| Gate | Result |
| --- | --- |
| `npm test` | 116 files, **1785 passed** |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint src tests` | exit 0 |
| `npm run build` | exit 0 |
| `npm run test:e2e` | **all 16 flows passed** (incl. void-order, invoice-shipped-order) |

E2E was run because this change alters the unlock/discard/void-order flows (owner instruction to run
E2E whenever a change touches any function or flow).

## Self-review

- `invoice-guards.ts` stays a leaf — imports only `type Prisma`; the leaf-import test in
  invoice-guards.test.ts (require/dynamic-import + `./orders`/`./shippers`/`./invoices` bans) still
  passes.
- Every guard reads under the claim its mutator already holds — no new lock (unlock: claimInvoiceRow;
  discard: claimLiveInvoice; voidOrder: claimOrder).
- Concurrency test verified RED (guard removed → both commit) then GREEN (restored).
- Messages verbatim for unlock and voidOrder; discard parallel and self-asserted.
- The "void re-permits" cases assert real success: unlock re-permit asserts `status === "DRAFT"` plus
  the before/after audit diff (FINALIZED→DRAFT) and reason; voidOrder re-permit asserts `voided ===
  true` after voiding the application and unlocking the invoice.
- Audit content asserted where a mutation succeeds (unlock's before/after + reason). No `vi.spyOn` on
  any Prisma delegate.

## Concerns

- `unlockInvoice` gained an optional `tx` third parameter (the established `finalizeInvoice`/
  `applyPayment` pattern for a discriminating concurrency test). The route and every existing caller
  pass only `(id, reason)`, so behavior is unchanged; tsc/eslint/build are green.
- The behavioral A/R refusal tests live in their brief-designated files (unlock+discard →
  invoices.test.ts, voidOrder → orders.test.ts, unit → invoice-guards.test.ts); the concurrency test
  is a new focused file `tests/unlock-concurrency.test.ts`, mirroring how
  `applications-concurrency.test.ts` is its own file.
- `voidOrder` checks A/R activity only on the order's finalized INVOICE (via `finalizedInvoiceFor`).
  A finalized credit applied to an invoice on a DIFFERENT order is not reachable while that target
  invoice is unlocked (unlock's own guard refuses it), so the same-order finalized invoice is the
  correct and sufficient anchor for this order's void.
  **→ This concern was WRONG and was the review's Important finding. See Fix round 1.**

---

## Fix round 1 — `voidOrder` order-level A/R guard (review Important)

**The gap (reviewer-verified, reachable).** `voidOrder`'s original A/R check ran
`hasReceivableActivity` only on the order's finalized INVOICE (`finalizedInvoiceFor`, kind INVOICE
only). A finalized CREDIT on the same order (`createCredit` copies `orderId: source.orderId`) with a
live cross-order application was missed:

1. `inv_O` finalized on order O; `createCredit(inv_O)` → `credit_C` on O; finalize `credit_C`.
2. `applyCredit(credit_C → inv_X)` where `inv_X` is on a DIFFERENT order → live Application
   `{ invoiceId: inv_X, creditInvoiceId: credit_C }`.
3. `unlockInvoice(inv_O)` succeeds (no application references `inv_O`) → `inv_O` → DRAFT.
4. `voidOrder(O)`: `finalizedInvoiceFor(O)` is now null → both A/R and bare finalized-invoice guards
   skipped → the void **succeeded**, orphaning live finalized `credit_C` (with live application) on a
   voided order. Violates §5.3.

**The fix.**
- Added `hasReceivableActivityForOrder(tx, orderId)` to the leaf `invoice-guards.ts` (still imports
  only `type Prisma`): a single existence query returning true iff a live `Application` exists whose
  `invoice.orderId === orderId` **or** whose `creditInvoice.orderId === orderId` (relation filters —
  no service import, leaf preserved; the leaf-import test still passes):
  ```ts
  const row = await tx.application.findFirst({
    where: { deletedAt: null, OR: [{ invoice: { orderId } }, { creditInvoice: { orderId } }] },
    select: { id: true },
  });
  return !!row;
  ```
- `voidOrder` now calls `hasReceivableActivityForOrder(tx, id)` (under the order claim it already
  holds) BEFORE the bare `finalizedInvoiceFor` refusal, message:
  `"This order cannot be voided — an invoice or credit on this order has A/R activity; void the
  payments or credits applied to it first"`. This closes the gap **and** the review's Minor (the
  cross-order-applied-credit-while-inv_O-still-finalized case, which previously fell through to the
  weaker bare-guard message). `unlockInvoice`/`discardInvoice` are unchanged.

**Regression test (orders.test.ts).** Builds the exact reachable sequence above through the real
services (`createCredit` → `finalizeInvoice` → `applyCredit(credit_C → inv_X on another order)` →
`unlockInvoice(inv_O)`), asserts `voidOrder(O)` REFUSES with the A/R message, then voids the
application and asserts `voidOrder(O)` SUCCEEDS with the trimmed reason on the delete audit entry.
Also added two `hasReceivableActivityForOrder` unit tests to invoice-guards.test.ts (INVOICE arm +
voided-drops-out; cross-order CREDIT arm).

**RED verification.** Disabling the order-level guard (`if (false && …)`) and running only the new
regression test: `voidOrder(O)` resolved instead of rejecting — `1 failed | 128 skipped` (the
reachable sequence orphaned the credit). Restored → GREEN.

**Covering-test results (foreground).**
```
npx vitest run tests/orders.test.ts tests/invoice-guards.test.ts
  tests/orders.test.ts (129 tests)         ✓
  tests/invoice-guards.test.ts (26 tests)  ✓
  Test Files  2 passed (2)   Tests  155 passed (155)
npx tsc --noEmit        → exit 0
npx eslint src tests    → exit 0
```

**Confirmation:** the reachable sequence (finalized cross-order credit on a voided-would-be order,
inv_O unlocked) now REFUSES `voidOrder` with the A/R message, and voiding the application re-permits
the void.
