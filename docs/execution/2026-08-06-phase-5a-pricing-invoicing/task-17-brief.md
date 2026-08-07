### Task 17: `/invoicing` — the worklist

**Files:**
- Create: `src/app/invoicing/page.tsx`, `src/app/invoicing/InvoicingList.tsx`, `src/app/api/invoices/export/route.ts`
- Test: browser verification

**Interfaces:**
- Consumes: `GET /api/invoices` and `GET /api/invoices?candidates=1`; `gate` (`src/lib/permission-ui.ts`); `useLatest` (`src/lib/use-latest.ts`).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Build the page** on `src/app/shipping/ShippingList.tsx`'s shape — a thin `page.tsx` delegating to a client component. Two sections:
  - **Ready to invoice** — the candidates (order number, customer, PO, last ship date), each row a checkbox, with a **Create invoices** button that POSTs each ticked order in turn and reports per-order failures **beside their order** rather than aborting the run (Task 11's create is per-order and independent, and the response must show that). Each candidate row links to its order.
  - **Invoices** — the list, filtered by customer / status / date range, each row linking to `/invoicing/<id>`, showing the document number, kind, status, total and finalized date. Excel export via the new `export` route, matching every other list in the app.
- [ ] **Step 2: Guard the loads with `useLatest`** — a stale search response must never overwrite a newer one (`src/lib/use-latest.ts`; issues #5/#15 are this exact bug twice). Drop any soft `.catch(() => {})`: a failed fetch says so, it does not impersonate an empty list.
- [ ] **Step 3: Gate every control** with the shared helper — **disabled with a title naming the missing permission, never hidden** (§5.16). The Create-invoices button needs `invoicing.create`.
- [ ] **Step 4: Verify in a real browser** per HANDOFF §5a — a shipped order appears, ticking and creating moves it out of Ready and into the list, the filters narrow correctly, and the export downloads. Clear the DEV-database fixtures afterwards.
- [ ] **Step 5: Gates + commit** — `feat(invoicing): worklist of orders ready to invoice, and the invoice list`

---

