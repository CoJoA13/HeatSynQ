### Task 9: `invoice-guards` A/R-activity + the unlock / discard / void refusals

**Files:**
- Modify: `src/server/invoice-guards.ts`, `src/server/invoices.ts` (`unlockInvoice`, `discardInvoice`), `src/server/orders.ts` (`voidOrder`)
- Test: `tests/invoice-guards.test.ts`, `tests/invoices.test.ts`, `tests/orders.test.ts`

**Interfaces:**
- Produces:
```ts
export async function hasReceivableActivity(tx: Prisma.TransactionClient, invoiceId: string): Promise<boolean>;
```
A live `Application` exists whose `invoiceId` = this OR whose `creditInvoiceId` = this (a credit that has been applied is also "active" paper).

- [ ] **Step 1: Failing test.** Finalize an invoice, apply a payment; `unlockInvoice` now throws 400 "Invoice #N has payments applied — void them before unlocking"; `discardInvoice` (after unlock is blocked, test a draft-with-activity path via a credit) similarly refuses; `voidOrder` on the order throws "an invoice on this order has A/R activity". Voiding the application re-permits all three.
- [ ] **Step 2: Run — Expected: FAIL** (unlock still succeeds).
- [ ] **Step 3: Implement `hasReceivableActivity`** as a dependency-free query in the leaf (no import of `invoices.ts`), then call it under the existing order claim in `unlockInvoice`/`discardInvoice`/`voidOrder`, throwing the field-anchored 400.
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Concurrency test — apply racing unlock.** Two transactions: one applies a payment, one unlocks; the unlock must refuse or the apply must, never both commit. Verify RED with the guard removed, competing caller Read Committed.
- [ ] **Step 6: `/gates`. Commit.**
```bash
git add src/server/invoice-guards.ts src/server/invoices.ts src/server/orders.ts tests/
git commit -m "feat(5b): refuse unlock/discard/void-order once an invoice has live A/R activity"
```

---

