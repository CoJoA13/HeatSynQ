### Task 6: `receipts.ts` — batches and payments, post and void

**Files:**
- Create: `src/server/receipts.ts`, `src/app/api/receivables/batches/route.ts`, `src/app/api/receivables/batches/[id]/route.ts`, `src/app/api/receivables/batches/[id]/payments/route.ts`, `src/app/api/receivables/batches/[id]/payments/[paymentId]/route.ts`
- Test: `tests/receipts.test.ts`, `tests/receivables-routes.test.ts`

**Interfaces:**
- Consumes: `allocateNumber("receipt_batch_number_next", tx)`, `auditedCreate/Update/SoftDelete`, `withDbErrors`, `assertRefExists`, `parseDate`.
- Produces:
```ts
export type BatchDetail = { id: string; batchNumber: number; depositDate: string; controlTotal: number | null;
  status: ReceiptBatchStatusValue; enteredTotal: number; balance: number; notes: string;
  payments: PaymentRow[]; deletedAt: string | null };
export type PaymentRow = { id: string; customerId: string; customerCode: string; customerName: string;
  paymentTypeId: string; paymentTypeName: string; amount: number; reference: string; receivedDate: string;
  onAccount: number };
export async function createBatch(input: unknown): Promise<BatchDetail>;
export async function getBatch(id: string): Promise<BatchDetail>;
export async function addPayment(batchId: string, input: unknown): Promise<BatchDetail>;   // refuses a POSTED batch
export async function voidPayment(batchId: string, paymentId: string, reason: string): Promise<BatchDetail>;
export async function postBatch(id: string): Promise<BatchDetail>;   // OPEN→POSTED, refuses if already POSTED
export async function voidBatch(id: string, reason: string): Promise<void>;   // refuses if it has live payments — void those first
```
`enteredTotal` = Σ live payment amounts; `balance` = `(controlTotal ?? enteredTotal) − enteredTotal` (zero when it foots or no control total set).

- [ ] **Step 1: Failing test — create + add payment + live balance.** Create a batch with `controlTotal 500`; add a payment of `300`; assert `enteredTotal 300`, `balance 200`. Add another of `200`; assert `balance 0`.
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement `createBatch`/`getBatch`/`addPayment`** — Serializable `$transaction`, `allocateNumber` under the transaction for `batchNumber`, `assertRefExists("customer", …)` / `assertRefExists("paymentType", …)` on a payment (the FK-writer pattern), audited. On-account per payment via `ar-balances.paymentOnAccount` over its (initially empty) applications.
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Failing test — post locks payment entry.** Post an OPEN batch; assert `status POSTED`; `addPayment` on it now throws 400 "This batch is posted — reopen or void a payment to change it". A second `postBatch` throws 400 "already posted".
- [ ] **Step 6: Run — Expected: FAIL.**
- [ ] **Step 7: Implement `postBatch`** under the batch claim (`SELECT … FROM "ReceiptBatch" WHERE id=$1 FOR UPDATE`), audited; `addPayment`/`voidPayment` refuse a POSTED batch read under the claim.
- [ ] **Step 8: Failing test — void.** `voidPayment` with a reason soft-deletes it and drops it from `enteredTotal`; `voidBatch` with live payments throws "void its payments first"; with none, soft-deletes with the reason in the audit entry.
- [ ] **Step 9: Implement the voids** (`auditedSoftDelete`, reason trimmed in the service — the `discardInvoice` precedent). Run — Expected: PASS.
- [ ] **Step 10: Routes.** Thin `handle` wrappers gating on `receivables.create`/`edit`/`delete`; `reasonFromBody` for the voids. Add the happy-path + 403 cases to `receivables-routes.test.ts`.
- [ ] **Step 11: `/gates`. Commit.**
```bash
git add src/server/receipts.ts src/app/api/receivables/batches/ tests/
git commit -m "feat(5b): receipt batches and payments — create, add, post, void, live balance"
```

---

