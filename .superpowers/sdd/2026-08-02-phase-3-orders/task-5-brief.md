### Task 5: Orders service — edits, void, link

**Files:**
- Modify: `src/server/orders.ts`
- Test: extend `tests/orders.test.ts`

**Interfaces (Produces):**
```ts
export async function updateOrder(id: string, input: unknown): Promise<{ order: OrderDetail; warnings: OrderWarnings }>;
// PATCH of: poNumber, vsOrderNumber, receivedDate, requestDate, targetDate (nullable), notes. NOTHING else.
export async function addLine(orderId: string, input: unknown): Promise<{ order: OrderDetail; warnings: OrderWarnings }>;   // rider only: position = max+1
export async function updateLine(orderId: string, lineId: string, input: unknown): Promise<{ order: OrderDetail; warnings: OrderWarnings }>; // qty/weight only; partId immutable
export async function removeLine(orderId: string, lineId: string): Promise<OrderDetail>;  // position 1 → 400 "The lead part cannot be removed — void the order instead"
export async function replaceContainers(orderId: string, input: unknown): Promise<OrderDetail>; // bulk PUT, Serializable + assertRefExists per distinct typeId
export async function replaceSerials(orderId: string, lineId: string, input: unknown): Promise<OrderDetail>; // bulk PUT per line
export async function replaceCharges(orderId: string, input: unknown): Promise<OrderDetail>;    // bulk PUT
export async function voidOrder(id: string, reason: string): Promise<void>;   // reason trimmed+required IN THE SERVICE
export async function linkOrder(id: string, otherId: string): Promise<OrderDetail>;   // same customer enforced
export async function unlinkOrder(id: string): Promise<OrderDetail>;
```
Every mutator: `withDbErrors` → Serializable tx → resolve the order `findFirst({ id, deletedAt: null })` (404 "Order not found" — voided orders are read-only) → `auditedUpdate("order", id, doIt, { tx })`. Warnings on qty/weight edits: `"Loads no longer sum to the order — re-split or edit loads"` when Σloads ≠ Σlines (qty or weight).

- [ ] **Step 1: Failing tests** — §12.9 in full: scalar PATCH audits a real diff (before/after show the changed field); customer/lead immutability (no input path — assert unknown keys 400 via `.strict()`, and `updateLine` on a lead can change qty but never `partId`/`revisionNumber`); rider add → position max+1; rider remove closes gaps (steps precedent — per-row updates ascending); removing the lead 400s with the exact message; qty edit returns the loads-mismatch warning, matching edit clears it; `replaceSerials` swaps a line's set atomically and rejects in-payload duplicates; `replaceContainers` under a concurrent `deleteReference("containerType")` — the Serializable pair (model on the existing `assertRefExists` race tests); void: requires non-blank reason (400 "A reason is required to void an order"), `auditedSoftDelete` entry carries it, voided order 404s from every mutator, still `getOrder`-readable, hidden from `listOrders` unless `includeVoided`; link: same-customer 400 otherwise, joins existing group, unlink clears, `linkedOrders` excludes self.
- [ ] **Step 2: Run — expect FAIL.**  **Step 3: Implement.**  **Step 4: PASS + gates.**
- [ ] **Step 5: Commit** — `feat: order edits, void with reason, linked orders`

