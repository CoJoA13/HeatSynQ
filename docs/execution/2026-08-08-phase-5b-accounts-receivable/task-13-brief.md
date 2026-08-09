### Task 13: `/receivables` — the batch worklist and the batch-entry + apply screen

**Files:**
- Create: `src/app/receivables/{page.tsx,ReceivablesList.tsx}`, `src/app/receivables/batches/[id]/{page.tsx,BatchDetail.tsx}`
- Modify: `src/components/Shell.tsx` (nav entry, gated on `receivables.view`)
- Test: covered by the E2E flow (Task 17); no unit test for the client component (the 5A `InvoicingList`/`InvoiceDetail` precedent — client pages are exercised by E2E, not vitest)

**Interfaces:** consumes the Task 6/7/8 routes. Follows 5A's `InvoiceDetail.tsx` binding-state model verbatim (the `key={id}` remount, `useMutationGate`, `useEditGuard`, `useBulkGrid`, `gate`/`gateDo` from `permission-ui`).

- [ ] **Step 1: Worklist.** `ReceivablesList.tsx` (client): open batches + a filter, each row linking to `/receivables/batches/[id]`; a "New batch" action (deposit date + optional control total) gated on `gate(perms, "receivables.create")`.
- [ ] **Step 2: Batch detail + apply grid.** `BatchDetail.tsx`: the batch header with the **live balance**; a payments table (add payment: payer customer, payment type, amount, check #); per payment an **apply panel** listing the payer's — and, when the payer has a parent/children, the family's — open finalized invoices, with an amount input, a "take discount" affordance shown only when `discountAvailable > 0`, and a write-off input (reason required) gated additionally on `gateDo(perms, "write_off")`; the unapplied remainder shown as on-account. Money controls gated on `receivables.edit`; a POSTED batch renders read-only (the 5A `statusLocked` shape). Post and void buttons with reason prompts.
- [ ] **Step 3: Nav.** Add "Receivables" to `Shell.tsx`, gated on `receivables.view`.
- [ ] **Step 4: Verify in the browser** (preview: create a batch, add a payment, apply a partial + a discount + a write-off, watch the balance and on-account update). Screenshot for the report.
- [ ] **Step 5: Commit.**
```bash
git add src/app/receivables/ src/components/Shell.tsx
git commit -m "feat(5b): receivables worklist + batch entry and apply screen"
```

---

