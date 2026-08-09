### Task 10: `aging.ts` — point-in-time aging into buckets + the unapplied column

**Files:**
- Create: `src/server/aging.ts`, `src/app/api/receivables/aging/route.ts`, `src/app/api/receivables/aging/export/route.ts`
- Test: `tests/aging.test.ts`, `tests/receivables-routes.test.ts`

**Interfaces:**
- Consumes: `ar-balances.*`, `AGING_BUCKETS`, `parseDate`/`formatDateOnly`.
- Produces:
```ts
export type AgingRow = { customerId: string; customerCode: string; customerName: string;
  current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number;
  unapplied: number; net: number };   // net = buckets − unapplied
type Snapshot = {
  invoices: { id: string; customerId: string; kind: "INVOICE" | "CREDIT"; total: number;
    dueDate: string | null; finalizedAt: string | null }[];
  applications: { invoiceId: string; creditInvoiceId: string | null; type: ApplicationTypeValue;
    amount: number; appliedDate: string }[];
  payments: { customerId: string; amount: number; appliedPaymentTotal: number }[]; };
/** PURE. Buckets each finalized INVOICE's open balance by dueDate vs asOf; open credit remaining +
 *  payment on-account go to `unapplied`. Only invoices finalized ≤ asOf and applications
 *  appliedDate ≤ asOf are counted (point-in-time reconstruction). */
export function bucketAging(snap: Snapshot, asOf: string, customers: CustomerRef[]): AgingRow[];
export async function agingReport(filter: { customerId?: string; asOf?: string }): Promise<AgingRow[]>;
```

- [ ] **Step 1: Failing test — buckets by due date.** Two finalized invoices for one customer: one due 15 days before `asOf` (→ `d1_30`), one due 40 days before (→ `d31_60`), each open `1000`; assert the row's buckets. An invoice due after `asOf` → `current`.
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement `bucketAging`** — pure, integer-cent. `daysPastDue = asOf − dueDate`; `≤0 → current`, `1..30 → d1_30`, …, `>90 → d90_plus`. Open credit remaining and payment on-account sum into `unapplied`; `net = Σ buckets − unapplied`.
- [ ] **Step 4: Failing test — point-in-time.** An invoice finalized AFTER `asOf` is excluded entirely; an application dated after `asOf` doesn't reduce the balance. Re-running with `asOf = today` includes both. Assert the same fixture ages differently at two `asOf` dates.
- [ ] **Step 5: Run both — Expected: PASS** (add the finalized-≤-asOf and appliedDate-≤-asOf filters).
- [ ] **Step 6: Failing test — family roll-up.** A parent + two children each with a `500` past-due invoice; `agingReport({ customerId: parent })` returns the family combined into the parent's row (or a per-child breakdown with a family total — return per-child rows plus a synthesized family total row keyed on the parent). Assert the family total.
- [ ] **Step 7: Implement `agingReport`** — read the snapshot (finalized invoices, live applications, payments for the customer/family), call `bucketAging`. Run — Expected: PASS.
- [ ] **Step 8: Routes** (JSON + an Excel export via the existing tsv/export helper, the `parts/export` precedent), gated on `receivables.view`. `/gates`. Commit.
```bash
git add src/server/aging.ts src/app/api/receivables/aging/ tests/
git commit -m "feat(5b): point-in-time aging into buckets with a separate unapplied column, family roll-up"
```

---

