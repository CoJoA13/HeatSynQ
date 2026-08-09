### Task 15: The statements screen + the customer A/R section

**Files:**
- Create: `src/app/receivables/statements/{page.tsx,Statements.tsx}`, `src/app/customers/[id]/ReceivablesSection.tsx`
- Modify: `src/app/customers/[id]/page.tsx` (mount the section)
- Test: E2E (Task 17)

- [ ] **Step 1: Statements screen.** `Statements.tsx` (client, `receivables.view`): pick a customer/family + as-of date + the **combined/per-division** choice + the **assess-finance-charges** toggle (off by default); Print (single) and a "Run for everyone with a balance" action; a documents list of archived statements (the 5A `InvoiceDocumentsList` precedent, links to `/api/documents/<id>`).
- [ ] **Step 2: Customer A/R section.** `ReceivablesSection.tsx` on the customer page: the customer's net balance and open items, with an inline aging strip and a "Statement" / "Apply payment" link — the order-hub `InvoicesSection` precedent (5A).
- [ ] **Step 3: Verify in the browser** (preview: print a combined family statement with an FC line; confirm it archives and reprints from Documents). Screenshot.
- [ ] **Step 4: Commit.**
```bash
git add src/app/receivables/statements/ src/app/customers/
git commit -m "feat(5b): statements screen (single + run, family, FC toggle) and customer A/R section"
```

---

