### Task 12: `statements.ts` + `pdf/statement.ts` + the STATEMENT document + route

**Files:**
- Create: `src/server/statements.ts`, `src/server/pdf/statement.ts`, `src/app/api/receivables/statements/route.ts`, `src/app/api/receivables/statements/run/route.ts`
- Test: `tests/statements.test.ts`, `tests/statement-pdf.test.ts`

**Interfaces:**
- Consumes: `aging.agingReport`, `ar-balances.*`, `finance-charges.*`, `invoicePrintSettings` (remit-to/company, 5A §10), `renderPdf`, `storeDocument({ kind: "STATEMENT", customerId }, pdf)`, `getDocument` (reprint).
- Produces:
```ts
export type StatementData = { asOf: string; company: {...}; remitTo: {...};
  customer: { code: string; name: string; billTo: string[] };
  openItems: { documentNumber: string; date: string; dueDate: string | null; kind: "INVOICE" | "CREDIT";
    original: number; open: number }[];
  aging: AgingRow; financeCharge: number | null; totalDue: number };
export async function buildStatement(customerId: string, opts: { asOf?: string; combineFamily: boolean; assessFinanceCharges: boolean }): Promise<StatementData>;
export async function printStatement(customerId: string, opts): Promise<{ documentId: string; pdf: Buffer }>;  // render + archive
export async function runStatements(opts: { asOf?: string; assessFinanceCharges: boolean }): Promise<{ customerId: string; documentId: string }[]>;  // everyone with an open balance
```

- [ ] **Step 1: Failing test — open-item assembly.** A customer with a finalized `1000` invoice partly paid (`open 400`), an open credit (`remaining 200`), on a Net-30 term 40 days past due; `buildStatement` returns the open item with `open 400`, an unapplied `−200`, the aging summary (`d31_60 400`, `unapplied 200`, `net 200`), `totalDue 200`, and `financeCharge null` (not assessed).
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement `buildStatement`** — read the customer's (or family's, `combineFamily`) finalized invoices + live applications + payments; compose open items via `ar-balances`; the aging via `agingReport`; `financeCharge` only when `assessFinanceCharges` and non-exempt past-due exists; remit-to via `invoicePrintSettings`.
- [ ] **Step 4: Run — Expected: PASS.**
- [ ] **Step 5: Failing test — FC assessed.** Same fixture with `assessFinanceCharges: true` and a plant rate `1.5` → `financeCharge = round(400 × 1.5%) = 6.00` on the statement.
- [ ] **Step 6: Run — Expected: PASS.**
- [ ] **Step 7: Failing test — print archives + reprint is byte-exact.** `printStatement` stores a `STATEMENT` document owned by the customer; a second call to `getDocument` returns the SAME stored bytes (`Buffer.compare === 0`). Pin content on the pdfmake DEFINITION (`allText`), never on two fresh renders (Global Constraints).
- [ ] **Step 8: Implement `pdf/statement.ts`** (plain data → pdfmake definition: header, remit-to, open-item table, aging strip, optional FC line, total due) and `printStatement` (the 5A four-print bracket: settings outside the tx → render → `storeDocument` on `tx`). `runStatements` iterates customers with a nonzero net.
- [ ] **Step 9: Run — Expected: PASS.** Routes gate on `receivables.view` (build/print) — the run on `receivables.create`. `/gates`. Commit.
```bash
git add src/server/statements.ts src/server/pdf/statement.ts src/app/api/receivables/statements/ tests/
git commit -m "feat(5b): open-item statements — assemble, render, archive, run; family and finance-charge options"
```

---

