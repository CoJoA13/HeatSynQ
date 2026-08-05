### Task 13: Shipping list page

**Files:**
- Create: `src/app/shipping/page.tsx`, `src/app/shipping/ShippingList.tsx`
- Modify: `src/components/Shell.tsx` (the Shipping nav entry goes live)
- Test: `tests/shipping-list.test.ts` (service-level filter coverage; the page is exercised by E2E)

- [ ] **Step 1: Write the failing filter tests** — customer filter, ship-date range, `includeVoided` default off, search matching packing-list number / BOL number / order number / customer code.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Build the page** — a client component against `/api/shippers`. Columns per §11. Use `useLatest` from `src/lib/use-latest.ts` on the load (both success and rejection paths), and **no `.catch(() => {})`** — a failed load renders a real error. Excel export button hits `/api/shippers/export`. Permission gating via `src/lib/permission-ui.ts`.
- [ ] **Step 4: Verify in the browser** with the Browser pane against `npm run dev`: the list renders, the voided toggle works, a failed request shows an error rather than an empty list. Screenshot for the demo doc.
- [ ] **Step 5: Run the tests** — PASS.
- [ ] **Step 6: Gates + commit** — `feat(ui): shipping list page`

---

