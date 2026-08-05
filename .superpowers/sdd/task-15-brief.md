### Task 15: Certifications worklist page

**Files:**
- Create: `src/app/certs/page.tsx`, `src/app/certs/CertList.tsx`
- Modify: `src/components/Shell.tsx` (the Certifications nav entry goes live)
- Test: `tests/cert-list.test.ts`

- [ ] **Step 1: Write the failing filter tests** — customer, scope, printed/unprinted, `includeVoided` default off, search over order number and customer code; `failCount` counts readings whose `passed === false`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Build the page** — columns per §11 (order label `#72036-3`, customer, scope, load or shipment, printed?, pass/fail summary), `useLatest`, no soft-catch, Excel export.
- [ ] **Step 4: Verify in the browser.** Screenshot.
- [ ] **Step 5: Run the tests** — PASS.
- [ ] **Step 6: Gates + commit** — `feat(ui): certifications worklist`

---

