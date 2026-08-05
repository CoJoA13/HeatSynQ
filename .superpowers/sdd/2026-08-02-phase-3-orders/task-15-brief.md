### Task 15: Delete-guard extensions + request-day overrides UI

**Files:**
- Modify: `src/server/parts.ts` (deletePart order-blockers), `src/server/customers.ts` (deleteCustomer order-blockers), `src/server/parts.ts`/`customers.ts` zod (accept `requestDaysOverride: z.number().int().min(0).nullable().optional()`), `src/app/parts/[id]/page.tsx` + `src/app/customers/[id]/page.tsx` (the override field, same commit — sibling habit)
- Test: extend `tests/parts.test.ts`, `tests/customers.test.ts`

- [ ] **Step 1: Failing tests**: deletePart refused while a live order's line references it — blocker rows `{ id: orderId, name: "#1042 · ACME", …detailPath "/orders/[id]" }` in the existing BlockerPanel shape + export; voided order does NOT block; deleteCustomer likewise (an order with only voided lines… any live order blocks); requestDaysOverride round-trips through create/update on both entities and 400s on negatives; audit diff shows the column.
- [ ] **Steps 2–3: implement service scans (same query shape as deleteCustomer's parts scan) + zod + UI fields → PASS + gates.**
- [ ] **Step 4: Commit** — `feat: live orders block part/customer deletion; request-day overrides`

