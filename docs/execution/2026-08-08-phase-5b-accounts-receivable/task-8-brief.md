### Task 8: Credit application

**Files:**
- Modify: `src/server/applications.ts`, `src/app/api/receivables/credit-applications/route.ts`
- Test: `tests/applications.test.ts`

**Interfaces:**
- Produces:
```ts
export async function applyCredit(input: { creditInvoiceId: string; invoiceId: string; amount: number }): Promise<void>;
```

- [ ] **Step 1: Failing test.** A finalized credit of `-500` (remaining `500`); a finalized invoice of `1000`; `applyCredit` `300` → invoice open `700`, credit remaining `200`. Over the credit's remaining → refused "exceeds the credit's remaining of 200". Over the invoice's open balance → refused. A DRAFT credit source → refused "only a finalized credit can be applied".
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement `applyCredit`.** Claim the target invoice's order+row AND the credit's own row `FOR UPDATE` (uniformly after the order claims — the credit is a second guarded balance, Global Constraints); read both live-application sums; refuse over-application on either side; `auditedCreate` an `Application` `{ type: "CREDIT", invoiceId, creditInvoiceId, paymentId: null, amount, appliedDate: todayDateOnly() }` (the `Application_source_check` enforces the null payment).
- [ ] **Step 4: Run — Expected: PASS.** Route gates on `receivables.create`.
- [ ] **Step 5: `/gates`. Commit.**
```bash
git add src/server/applications.ts src/app/api/receivables/credit-applications/ tests/
git commit -m "feat(5b): apply a finalized credit memo to an invoice, both balances guarded"
```

---

