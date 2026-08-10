## Task 6: `gl-export.ts` — per-event delta, CSV, batch write, + export/readiness routes

**Files:**
- Create: `erp/src/server/gl-export.ts`
- Create: `erp/src/app/api/receivables/close/[id]/export/route.ts`, `close/export/[batchId]/file/route.ts`, `close/readiness/route.ts`, `close/readiness/export/route.ts`
- Test: `erp/tests/gl-export.test.ts`, `erp/tests/receivables-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `salesJournal`/`cashJournal`/`readinessGaps`/`JournalLine`/`ReadinessGap` (Task 3), `getBillingConfig` (Task 2), `allocateNumber`, `toXlsx`, `formatDateOnly`.
- Produces: `exportClose(closePeriodId)`, `readinessForExport(periodEnd)`, `getExportBatchFile(batchId)`, `getExportBatchRegister(batchId)` — consumed by the UI (Task 8) and the file/register routes.

**The delta (§4.3).** For the close's period-end `E`: gather in-scope live postable events (finalized invoices/credits by `invoiceDate ≤ E`; posted non-void payments by `receivedDate ≤ E`; live discount/write-off applications by `appliedDate ≤ E`), and the net prior postings (`GlPosting` with `glDate ≤ E`, grouped by `(sourceType, sourceId)`, reversals cancelling). **New** = live events with no net prior posting → post. **Reversed** = net-posted events no longer live-in-scope → reverse. Both sides bound by `glDate ≤ E`, so re-exporting an earlier month after a later one closed never disturbs the later month.

- [ ] **Step 1: Write the failing delta tests.** Create `erp/tests/gl-export.test.ts`:

```ts
import { beforeEach, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";
import { exportClose } from "@/server/gl-export";
import { closePeriod, reopenPeriod } from "@/server/close-periods";
import { unlockInvoice } from "@/server/invoices";
// helpers set up GL accounts + BillingConfig defaults + a finalized invoice + a payment

it("first export posts a balanced batch; a re-run is an empty no-op", async () => {
  await seedGlDefaults();
  await makeFinalizedInvoiceDated("2026-07-05", 100);
  await closePeriod(2026, 7);
  const period = await prisma.closePeriod.findFirstOrThrow({ where: { year: 2026, month: 7 } });
  const first = await exportClose(period.id);
  const debit = first.postings.reduce((s, p) => s + p.debit, 0);
  const credit = first.postings.reduce((s, p) => s + p.credit, 0);
  expect(Math.round(debit * 100)).toBe(Math.round(credit * 100)); // balances
  expect(first.postings.length).toBeGreaterThan(0);
  const second = await exportClose(period.id);
  expect(second.postings.length).toBe(0); // idempotent
});

it("a reopen → void → re-close → re-export emits a reversing delta", async () => {
  await seedGlDefaults();
  const invId = await makeFinalizedInvoiceDated("2026-07-05", 100);
  await closePeriod(2026, 7);
  const period = await prisma.closePeriod.findFirstOrThrow({ where: { year: 2026, month: 7 } });
  await exportClose(period.id);
  await reopenPeriod(period.id, "correcting");
  await unlockInvoice(invId, "wrong amount"); // now dated-in-July invoice is DRAFT again
  await closePeriod(2026, 7);
  const delta = await exportClose(period.id);
  const net = delta.postings.reduce((s, p) => s + (p.debit - p.credit), 0);
  expect(delta.postings.length).toBeGreaterThan(0);
  expect(Math.round(net * 100)).toBe(0); // a balanced reversal
});
```

- [ ] **Step 2: Run red.**

```bash
npx vitest run tests/gl-export.test.ts -t "first export posts a balanced batch"
```

Expected: FAIL.

- [ ] **Step 3: Implement `gl-export.ts`.** Read live events + BillingConfig + the invoice-line revenue groups, map via `gl-mapping`, diff against `GlPosting`, allocate the export number, write the batch + postings, render the CSV. (The register PDF lands in Task 7; write a minimal CSV here and a placeholder single-byte register, replaced in Task 7 — or sequence Task 7 before the batch write; the plan keeps the register in Task 7 and this task stores an empty register buffer, noting the follow-up. Prefer: Task 7 supplies `buildPostingRegister`, imported here; if executing 6 before 7, store `new Uint8Array()` and let Task 7's step replace it.) Core shape:

```ts
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors";
import { HttpError } from "./errors";
import { auditedCreate } from "./audit";
import { allocateNumber } from "./settings";
import { getBillingConfig } from "./billing-config";
import { salesJournal, cashJournal, reverseLines, readinessGaps, type JournalLine, type ReadinessGap } from "./gl-mapping";
import { formatDateOnly } from "@/lib/business-days";
import { GL_EXPORT_COLUMNS } from "@/lib/gl-constants";

const cents = (n: number) => Math.round(n * 100);

export type ExportedBatch = {
  batchId: string; exportNumber: number; periodEnd: string;
  postings: { sourceType: string; sourceId: string; glAccountId: string | null; debit: number; credit: number; side: string; isReversal: boolean }[];
  file: Buffer;
};

// 1. build the CURRENT in-scope journal lines (live events with glDate <= periodEnd), keyed by event
// 2. read prior GlPosting (glDate <= periodEnd), net by (sourceType, sourceId)
// 3. new events -> post; net-posted-but-not-live -> reverse
// 4. write GlExportBatch + GlPosting, render CSV
export async function exportClose(closePeriodId: string): Promise<ExportedBatch> {
  return withDbErrors({ entity: "GL export" }, () => prisma.$transaction(async (tx) => {
    const period = await tx.closePeriod.findFirst({ where: { id: closePeriodId } });
    if (!period) throw new HttpError(404, "Close period not found");
    if (period.status !== "CLOSED") throw new HttpError(409, "Reopened periods must be re-closed before export");
    const periodEnd = new Date(Date.UTC(period.year, period.month, 0));

    const gaps = await resolveReadiness(tx, periodEnd);
    if (gaps.length > 0) throw new HttpError(409, `Cannot export — ${gaps.length} GL account gap(s); see the readiness list`);

    // Both maps keyed on the IDENTICAL 2-part `${sourceType}:${sourceId}` (§4.3). buildPriorNet
    // drops net-zero groups (an already-reversed event), so presence (.has) == "has a live posting".
    const currentByKey = await buildCurrentJournal(tx, periodEnd); // Map<key, JournalLine[]> (new-posting lines, isReversal:false)
    const priorByKey = await buildPriorNet(tx, periodEnd);         // Map<key, JournalLine[]> (net non-zero prior lines)

    const lines: JournalLine[] = [];
    for (const [key, cur] of currentByKey) {
      if (!priorByKey.has(key)) lines.push(...cur); // new event → post
    }
    for (const [key, prior] of priorByKey) {
      if (!currentByKey.has(key)) lines.push(...reverseLines(prior)); // net-posted but no longer live → reverse
    }

    const exportNumber = await allocateNumber("gl_export_batch_number_next", tx);
    const fileName = `gl-${period.year}-${String(period.month).padStart(2, "0")}.csv`;
    const file = renderCsv(lines, formatDateOnly(periodEnd));
    const register = new Uint8Array(); // Task 7 replaces this with the rendered posting-register PDF
    const batch = await auditedCreate("glExportBatch",
      { exportNumber, closePeriodId, periodEnd, fileName },
      () => tx.glExportBatch.create({
        data: {
          exportNumber, closePeriodId, periodEnd, fileName,
          file: new Uint8Array(file), register,
          postings: { create: lines.map((l) => ({
            sourceType: l.sourceType, sourceId: l.sourceId, glDate: periodEnd,
            glAccountId: l.glAccountId, glAccountName: l.glAccountName, memo: l.memo,
            debit: l.debit, credit: l.credit, side: l.side, isReversal: l.isReversal })) },
        },
        select: { id: true, exportNumber: true, postings: true },
      }), { tx });

    return {
      batchId: batch.id, exportNumber, periodEnd: formatDateOnly(periodEnd),
      postings: batch.postings.map((p) => ({ sourceType: p.sourceType, sourceId: p.sourceId, glAccountId: p.glAccountId, debit: p.debit.toNumber(), credit: p.credit.toNumber(), side: p.side, isReversal: p.isReversal })),
      file,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
```

Implement the private helpers below the export (`reverseLines` is imported from `gl-mapping`, not re-implemented):
- `buildCurrentJournal(tx, periodEnd)`: read finalized invoices/credits (`invoiceDate ≤ periodEnd`) with their lines grouped by `glAccountId` into `SalesEvent.revenue`; posted non-void payments (`receivedDate ≤ periodEnd`) → one `CashEvent{ kind:"PAYMENT" }` each; live `DISCOUNT`/`WRITE_OFF` applications (`appliedDate ≤ periodEnd`) → one `CashEvent` each. Map each via `salesJournal`/`cashJournal`. Return `Map<`${sourceType}:${sourceId}`, JournalLine[]>` — **the 2-part key**.
- `buildPriorNet(tx, periodEnd)`: read `GlPosting` with `glDate ≤ periodEnd`; group by the **same 2-part `${sourceType}:${sourceId}`**; within a group net debit/credit per `(glAccountId, side, memo)`, reconstructing `JournalLine[]` (carry `memo` and `glAccountName` from the row). **Drop any group whose every line nets to zero** (an already-reversed event) so `.has(key)` means "has a live prior posting".
- `resolveReadiness(tx, periodEnd)`: assemble `ReadinessInput` from `getBillingConfig()` (its `arGlAccountId`/`discountGlAccountId`/`writeOffGlAccountId`/`salesTaxGlAccountId`) + the account-less step codes/surcharges/payment types that appear on in-scope events (`glDate ≤ periodEnd`); set `hasDiscount`/`hasWriteOff` from whether any such application is in scope, and `hasTax` from whether any in-scope finalized invoice has `taxTotal != 0`; call `readinessGaps`.
- `renderCsv(lines, dateStr)`: join `GL_EXPORT_COLUMNS`; one row per line — date, `glAccountName`, debit, credit, memo.
- `export async function getExportBatchFile(batchId): Promise<{ bytes: Buffer; fileName: string; contentType: string }>` and `getExportBatchRegister(batchId): Promise<{ bytes: Buffer; contentType: string }>`: read the stored `file`/`register` bytes (`prisma.glExportBatch.findFirst`, 404 if missing) for the file/register routes.
- `export async function readinessForExport(periodEnd: Date): Promise<ReadinessGap[]>`: wrap `resolveReadiness` in its own transaction — the **same** period-end the export refusal uses, so the UI's readiness panel and disabled-count match `exportClose`'s refusal exactly (§7).

*Grouping key subtlety (copy 5B's identity discipline):* key both maps by the FULL `(sourceType, sourceId)` — an invoice's cuid, a payment's cuid, an application's cuid — never a position or a display field. Because each event maps to a self-balancing set of lines under one id (§ Task 3), the 2-part key both nets correctly and reverses one event without touching another. These ids are never reused.

- [ ] **Step 4: Run the delta tests green.**

```bash
npx vitest run tests/gl-export.test.ts
```

Expected: PASS (balanced first batch, empty re-run, balanced reversal).

- [ ] **Step 5: Add the earlier-month-after-later test** — close July, close August, reopen+correct+re-close July, and assert the July re-export's postings all carry `glDate ≤ 2026-07-31` and August's batch is untouched (`glPosting` rows for August's sourceIds are unchanged).

- [ ] **Step 6: Add the export + readiness routes.** `close/[id]/export/route.ts` (POST, `run_qbo_export`), `close/export/[batchId]/file/route.ts` (GET, `receivables.view`, `getExportBatchFile` → streams `text/csv` attachment), `close/readiness/route.ts` (GET, `receivables.view`, **period-scoped** `?year=&month=` → `readinessForExport(monthEnd)` JSON gap list), `close/readiness/export/route.ts` (GET, `receivables.view`, same `?year=&month=`, `toXlsx("Readiness", …)`). The `?year=&month=` on both readiness routes is what keeps the UI's panel and disabled-count aligned with `exportClose`'s refusal. Export route shape:

```ts
export const POST = handle(async (req, ctx) => {
  const user = requireUser();
  mustCan(user, "receivables", "edit");
  mustDo(user, "run_qbo_export");
  const { id } = await ctx.params;
  return NextResponse.json(await exportClose(id));
});
```

The readiness xlsx route copies `aging/export/route.ts` verbatim, parsing `year`/`month` from the URL, computing the month-end (`new Date(Date.UTC(year, month, 0))`), calling `readinessForExport(monthEnd)`, and using columns `{ key: "label", header: "Gap" }`, `{ key: "href", header: "Fix at" }`.

- [ ] **Step 7: Add the route ladder + xlsx-body tests** to `receivables-routes.test.ts` (401/403/200; assert the file route's `content-type: text/csv` and the readiness export's xlsx MIME).

- [ ] **Step 8: Run gates.**

```bash
npx vitest run tests/gl-export.test.ts tests/receivables-routes.test.ts
npx tsc --noEmit && npx eslint src tests
```

- [ ] **Step 9: Commit.**

```bash
git add erp/src/server/gl-export.ts erp/src/app/api/receivables/close erp/tests/gl-export.test.ts erp/tests/receivables-routes.test.ts
git commit -m "feat(5c): GL-export delta engine (idempotent, reversal-safe), CSV, readiness refusal + routes"
```

---

