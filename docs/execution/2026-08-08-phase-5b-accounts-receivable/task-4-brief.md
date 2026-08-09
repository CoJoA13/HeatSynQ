### Task 4: `Terms` and `BillingConfig` columns wired through their admin screens

**Files:**
- Modify: `src/server/terms.ts` (or the reference service that owns Terms), `src/server/billing-config.ts`, `src/app/admin/billing/page.tsx`, the Terms admin page/section
- Test: `tests/settings.test.ts` (or `tests/billing-config.test.ts`), the reference/terms test

**Interfaces:**
- Consumes: the existing reference/Terms CRUD and `getBillingConfig`/`updateBillingConfig`.
- Produces: Terms carrying `netDays` (required, default 30) + optional `discountPercent`/`discountDays`; `BillingConfig.financeChargeRate` read/written.

- [ ] **Step 1: Failing test — Terms discount validation.** A Terms zod schema test: `netDays` required int ≥ 0; a discount is all-or-nothing — supplying `discountPercent` without `discountDays` (or vice versa) is a 400 "an early-pay discount needs both a percent and a day count"; `2/10/30` round-trips.
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Extend the Terms schema/service.** Add `netDays` (`z.number().int().min(0)`, default 30), `discountPercent`/`discountDays` (`decimalField(5,2)` / `z.number().int().min(1)`, both optional) with a `.refine` enforcing both-or-neither. Persist through the existing audited path.
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Failing test — plant FC rate.** `billing-config.test.ts`: set `financeChargeRate` to `1.5`, read it back as `1.5`; reject a negative.
- [ ] **Step 6: Run — Expected: FAIL.**
- [ ] **Step 7: Add `financeChargeRate` to the `BillingConfig` zod registry** (`decimalField(6,4,{min:"nonnegative"})`, optional) and its read/write.
- [ ] **Step 8: Run — Expected: PASS.**
- [ ] **Step 9: Add the UI fields.** Terms admin gains `netDays` + the two discount inputs (with the both-or-neither hint); Admin → Billing gains a "Finance charge (monthly %)" input bound to `financeChargeRate`. Follow the existing field patterns on those pages; no new components.
- [ ] **Step 10: `/gates`, then verify in the browser** (preview: Admin → Billing shows and saves the rate; Terms saves `2/10 Net 30`). Commit.
```bash
git add src/server/terms.ts src/server/billing-config.ts src/app/admin/ tests/
git commit -m "feat(5b): terms netDays + early-pay discount, plant finance-charge rate, and their admin fields"
```

---

