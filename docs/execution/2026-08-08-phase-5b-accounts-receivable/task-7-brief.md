### Task 7: `applications.ts` — apply a payment, discount, write-off, and on-account

**Files:**
- Create: `src/server/applications.ts`, `src/app/api/receivables/applications/route.ts`, `src/app/api/receivables/applications/[id]/route.ts`
- Test: `tests/applications.test.ts`, `tests/applications-concurrency.test.ts`

**Interfaces:**
- Consumes: `claimInvoiceRow`/`claimOrdersInOrder` (`invoices.ts`/`order-locks.ts`), `ar-balances.*`, the payment's terms (for the discount window), `auditedCreate/SoftDelete`.
- Produces:
```ts
// one call applies a payment across one or more invoices in a single claim
export async function applyPayment(input: {
  paymentId: string;
  lines: { invoiceId: string; type: "PAYMENT" | "DISCOUNT" | "WRITE_OFF"; amount: number; reason?: string }[];
}): Promise<void>;
export async function voidApplication(id: string, reason: string): Promise<void>;   // restores balances
export async function discountAvailable(paymentId: string, invoiceId: string): Promise<number>;   // 0 when out of window / no terms discount
```

- [ ] **Step 1: Failing test — partial payment + open balance.** A finalized invoice of `1000`; a payment of `600`; `applyPayment` one `PAYMENT` line of `600`; assert the invoice open balance is `400` and the payment on-account is `0`. Apply another `600` → **refused** 400 "exceeds the invoice's open balance of 400".
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement the claim + write.** Serializable `$transaction`; collect the target invoices' order ids and `claimOrdersInOrder(tx, orderIds)` (one sorted statement), then `FOR UPDATE` each invoice row; read each invoice's live applications; refuse if a line would push `Σ applications > invoice.total` (over-application) or `Σ PAYMENT lines > payment.amount`; `auditedCreate` each `Application` with `appliedDate = payment.receivedDate` (the A/R-effective date aging's point-in-time filter reads — Task 10; a standalone bad-debt write-off with no payment uses `todayDateOnly()`). The unapplied remainder is on-account by construction (no write).
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Failing test — discount window.** Terms `2/10 Net 30`; invoice dated today; a payment received today; `discountAvailable` returns `2% × the settled amount`; the same invoice with a payment received 20 days later returns `0`. Applying a `DISCOUNT` line outside the window is refused 400 "no early-pay discount applies".
- [ ] **Step 6: Run — Expected: FAIL.**
- [ ] **Step 7: Implement `discountAvailable` + the DISCOUNT guard** — eligible iff the terms carry a discount and `payment.receivedDate ≤ invoice.invoiceDate + discountDays`; amount = `round(discountPercent/100 × settledAmount)`.
- [ ] **Step 8: Failing test — write-off needs a reason and the `write_off` action.** A `WRITE_OFF` line with no reason → 400 "a write-off needs a reason"; with a reason it reduces the open balance and the reason is in the audit entry. (Route-level `write_off` gating is Task 16's sweep; assert the service records the reason here.)
- [ ] **Step 9: Implement WRITE_OFF** (reason required, trimmed). Run — Expected: PASS.
- [ ] **Step 10: Failing test — void restores.** `voidApplication` on the `600` PAYMENT restores the invoice to `1000` open and the payment to `600` on-account.
- [ ] **Step 11: Implement `voidApplication`** (`auditedSoftDelete` under the invoice claim). Run — Expected: PASS.
- [ ] **Step 12: Concurrency test — two applications on one invoice.** In `applications-concurrency.test.ts`: open two manual transactions, both apply against a `1000` invoice with `700` each; the second must see the first's committed row and refuse (not both succeed to `1400`). **Verify RED** by commenting out the `FOR UPDATE` claim and pinning the competing tx to Read Committed (Global Constraints). Run — Expected: PASS with the claim, FAIL without.
- [ ] **Step 13: Routes + `/gates`. Commit.**
```bash
git add src/server/applications.ts src/app/api/receivables/applications/ tests/
git commit -m "feat(5b): apply payments, discounts, write-offs across invoices under one sorted claim"
```

---

