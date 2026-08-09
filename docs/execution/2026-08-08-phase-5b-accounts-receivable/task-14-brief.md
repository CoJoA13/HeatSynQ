### Task 14: The aging report screen

**Files:**
- Create: `src/app/receivables/aging/{page.tsx,AgingReport.tsx}`
- Test: E2E (Task 17)

- [ ] **Step 1: Report.** `AgingReport.tsx` (client, gated on `receivables.view`): an as-of date picker (default today) + a customer/family filter; a table of `AgingRow`s (the five buckets + Unapplied + Net), a totals footer, and an **Excel export** button hitting the export route. Reuse the parts/customers list styling.
- [ ] **Step 2: Verify in the browser** (preview: the fixture from Task 10 ages correctly; changing the as-of date re-buckets). Screenshot.
- [ ] **Step 3: Commit.**
```bash
git add src/app/receivables/aging/
git commit -m "feat(5b): A/R aging report screen with as-of date and Excel export"
```

---

