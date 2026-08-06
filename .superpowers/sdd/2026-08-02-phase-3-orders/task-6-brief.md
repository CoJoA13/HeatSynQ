### Task 6: Loads service

**Files:**
- Create: `src/server/order-loads.ts`
- Test: `tests/order-loads.test.ts`

**Interfaces (Produces):**
```ts
export type LoadInput = { loadNumber: number; qty: number | null; weight: number | null };
export async function replaceLoads(orderId: string, input: unknown): Promise<{ order: OrderDetail; warnings: OrderWarnings }>;
// bulk PUT: validates loadNumbers are 1..N exactly once (two-phase negative-park rewrite against
// @@unique([orderId, loadNumber])); each row needs qty or weight (or both); ≥ 1 load.
export async function resplitLoads(orderId: string): Promise<{ order: OrderDetail; warnings: OrderWarnings }>;
// re-runs splitLoads on current totals + lead caps, replacing all loads.
```
Warnings (never blocks): sum mismatch (as Task 5) and `"A traveler has already printed — print a fresh one"` when any `StoredDocument` exists for the order (§3.3).

- [ ] **Step 1: Failing tests**: replace validates the 1..N set (400 "Load numbers must be 1..N with no gaps or repeats"), swaps a renumber atomically (reverse 3 loads' numbers in one call — the two-phase pattern), rejects a row with neither qty nor weight; resplit rebuilds from current lead caps after a qty edit; both return the printed warning iff a stored document exists (seed one directly via prisma in the test); voided order 404s; audit diff shows the load change.
- [ ] **Steps 2–4: FAIL → implement → PASS + gates.**
- [ ] **Step 5: Commit** — `feat: load editing, renumbering, re-split`

