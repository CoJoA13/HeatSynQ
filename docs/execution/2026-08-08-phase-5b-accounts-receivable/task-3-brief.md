### Task 3: The two 5A invoice changes — credit date, and `dueDate` at finalize

**Files:**
- Modify: `src/server/invoices.ts` (`createCredit`, `finalizeInvoiceInTx`)
- Test: `tests/invoices.test.ts`

**Interfaces:**
- Consumes: `todayDateOnly()` (`src/lib/business-days.ts`); the customer's `terms.netDays` (Task 2 column).
- Produces: a credit's `invoiceDate` = its own creation date; a finalized `INVOICE`'s `dueDate` = `invoiceDate + terms.netDays`.

- [ ] **Step 1: Failing test — credit date.** In `tests/invoices.test.ts` `createCredit` describe, add: raise a credit against an invoice whose `invoiceDate` is 30 days ago; assert `credit.invoiceDate === formatDateOnly(todayDateOnly())`, not the source's date. (Amends the existing "copies the header" test — that one currently expects the source date; update its assertion in the same step and note the change in the commit.)
- [ ] **Step 2: Run — Expected: FAIL** (credit still carries the source's date).
- [ ] **Step 3: Change `createCredit`.** In the `invoice.create` data and the `auditData`, set `invoiceDate: todayDateOnly()` (import already present as `todayDateOnly` via `deps.today` in create; `createCredit` has no `deps`, so call `todayDateOnly()` directly at the service boundary). Everything else copies verbatim.
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Failing test — dueDate.** Add: a customer on Net 30 terms, finalize an invoice dated `2026-08-01`; assert `invoice.dueDate === "2026-08-31"`. A customer with no terms → `dueDate` null.
- [ ] **Step 6: Run — Expected: FAIL** (`dueDate` is null / column unread).
- [ ] **Step 7: Compute `dueDate` in `finalizeInvoiceInTx`.** After the `needsPrice` guard, read `order.customer.terms.netDays` (extend the customer select already in the claim path), and for an `INVOICE` (not a `CREDIT`) set `data: { status: "FINALIZED", finalizedAt, finalizedById, dueDate: addDays(invoice.invoiceDate, netDays) }`. Add a small `addDays(date, n)` to `business-days.ts` if absent (a date-only add, no business-day skipping — a due date is a calendar date). `netDays` null → `dueDate` stays null.
- [ ] **Step 8: Run — Expected: PASS.** Then `/gates`.
- [ ] **Step 9: Commit.**
```bash
git add src/server/invoices.ts src/lib/business-days.ts tests/invoices.test.ts
git commit -m "feat(5b): credit takes its own date; invoice dueDate set at finalize from terms.netDays"
```

---

