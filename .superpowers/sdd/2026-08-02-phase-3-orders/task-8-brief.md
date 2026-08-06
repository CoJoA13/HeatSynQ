### Task 8: Global search service

**Files:**
- Create: `src/server/search.ts`
- Test: `tests/search.test.ts`

**Interfaces (Produces):**
```ts
export type SearchResults = {
  exactOrderId: string | null;   // input is all digits AND matches a live order's number
  orders: { id: string; orderNumber: number; customerCode: string; poNumber: string; leadPartNumber: string }[];
  parts: { id: string; partNumber: string; customerCode: string; name: string }[];
  customers: { id: string; code: string; name: string }[];
};
export async function globalSearch(user: SessionUser, q: string): Promise<SearchResults>;
```
Groups the caller lacks `*.view` for come back EMPTY (permission-filtered inside the service via `can(user, area, "view")`; orders group covers number / PO / VS# / serial matches (serial via `OrderSerial` join); voided orders excluded; ≤ 10 rows per group, ordered by recency. `q.trim()` < 1 char → all empty.

- [ ] **Step 1: Failing tests**: exact number short-circuit (`"1042"` → `exactOrderId`, still fills groups); serial hit surfaces its order; PO and VS# hits; part by number (per-customer duplicate numbers BOTH returned with their customer codes — §15-decision heritage: a number alone never identifies a part); permission filtering (user with only `parts.view` gets empty orders+customers groups); voided excluded.
- [ ] **Steps 2–4: FAIL → implement → PASS + gates.**  **Step 5: Commit** — `feat: global search service`

