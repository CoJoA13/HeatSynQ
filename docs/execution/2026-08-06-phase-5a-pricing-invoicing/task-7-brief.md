### Task 7: Admin → Surcharges page + routes

**Files:**
- Create: `src/app/api/admin/surcharges/route.ts`, `src/app/api/admin/surcharges/[id]/route.ts`, `src/app/api/admin/surcharges/[id]/step-codes/route.ts`, `src/app/api/admin/surcharges/[id]/blockers/route.ts`, `src/app/api/admin/surcharges/[id]/blockers/export/route.ts`, `src/app/admin/surcharges/page.tsx`
- Modify: `src/app/admin/page.tsx`
- Test: `tests/surcharges.test.ts` (route cases appended)

**Interfaces:**
- Consumes: everything Task 6 produces; `findBlockers("surcharge", id)`; `BlockerPanel` (`src/app/parts/[id]/…` — the shared component 2C-2 added).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Route tests** appended to `tests/surcharges.test.ts` — 401 unauthenticated, 403 without `admin.view` on GET and without `admin.edit` on POST/PUT/DELETE, 200 with them. `handler(request, { params: Promise.resolve({ id }) })`.
- [ ] **Step 2: The five routes**, copied from `src/app/api/admin/step-codes/**` and re-pointed at `surcharges.ts`. `mustCan(requireUser(), "admin", "view" | "edit")`. The blockers pair is a straight copy with `"processStepCode"` swapped for `"surcharge"`.
- [ ] **Step 3: The page** `src/app/admin/surcharges/page.tsx`, modelled on `src/app/admin/step-codes/page.tsx`: a list of surcharges with inline edit, a **needs GL account** badge, the kind/rate/amount/minimum controls (rate shown as a percent and stored as a decimal — label it `%` and divide by 100 on save, so `4` on screen stores `0.040000`), a scope selector, and — when scope is not `ALL` — a multi-select of process step codes from `/api/picklists/processStepCode`. Delete shows the `BlockerPanel` with its Excel export on refusal. All controls gate on `admin.edit`, **disabled with a title, never hidden**.
- [ ] **Step 4: Verify in a real browser** per HANDOFF §5a — create a surcharge, set scope `EXCLUDE` with two step codes, reload, confirm both persist; delete one that a customer rule points at and confirm the blocker panel names the customer and links to it. Clear fixtures from the DEV database afterwards.
- [ ] **Step 5: Gates + commit** — `feat(admin): surcharges page with scope, GL account and blocker panel`

---

