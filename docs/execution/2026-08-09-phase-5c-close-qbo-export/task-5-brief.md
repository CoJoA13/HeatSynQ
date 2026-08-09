## Task 5: `close-periods.ts` — the close/reopen lifecycle + preliminary report + routes

**Files:**
- Create: `erp/src/server/close-periods.ts`
- Modify: `erp/src/server/close-periods.ts` tests → `erp/tests/close-periods.test.ts` (extend Task 1's smoke file)
- Create: `erp/src/app/api/receivables/close/preliminary/route.ts`, `close/route.ts`, `close/[id]/reopen/route.ts`
- Test: `erp/tests/receivables-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `agingReport({ asOf })` from `aging.ts`, `lockMonth` from `period-locks.ts`, `getBillingConfig`, `allocateNumber`, `auditedCreate`/`auditedUpdate`, `formatDateOnly`/`parseDateOnly` from `business-days.ts`.
- Produces: `preliminaryReport(year, month)`, `closePeriod(year, month)`, `reopenPeriod(id, reason)` and the types below (consumed by `gl-export.ts` Task 6 and the UI Task 8).

- [ ] **Step 1: Write the failing close tests.** Extend `erp/tests/close-periods.test.ts`:

```ts
import { closePeriod, preliminaryReport, reopenPeriod } from "@/server/close-periods";
// helpers: finalize an invoice dated in a month; post a payment applied to it (existing factories)

it("closes a clean month: beginning 0, chains, reconciles to aging (variance 0)", async () => {
  await makeFinalizedInvoiceDated("2026-07-05", 100); // total 100
  await payInvoiceDated("2026-07-20", 40);            // pay 40
  const prelim = await preliminaryReport(2026, 7);
  expect(prelim.schedule.beginningAr).toBe(0);
  expect(prelim.schedule.invoicedTotal).toBe(100);
  expect(prelim.schedule.paymentTotal).toBe(40);
  expect(prelim.schedule.endingAr).toBe(60);
  expect(prelim.schedule.variance).toBe(0); // endingAr === agingEndingAr
  const closed = await closePeriod(2026, 7);
  expect(closed.status).toBe("CLOSED");
  expect(closed.endingAr).toBe(60);
});

it("chains beginning A/R from the prior close", async () => {
  await makeFinalizedInvoiceDated("2026-07-05", 100);
  await closePeriod(2026, 7);
  await makeFinalizedInvoiceDated("2026-08-05", 30);
  const aug = await closePeriod(2026, 8);
  expect(aug.beginningAr).toBe(100); // July's ending
  expect(aug.endingAr).toBe(130);
});

it("refuses to close a month before its prior month is closed", async () => {
  await makeFinalizedInvoiceDated("2026-08-05", 30);
  await expect(closePeriod(2026, 8)).rejects.toThrow(/prior|previous|July|2026-07/i);
});

it("reopen requires a reason and flips status", async () => {
  await makeFinalizedInvoiceDated("2026-07-05", 100);
  const c = await closePeriod(2026, 7);
  await expect(reopenPeriod(c.id, "  ")).rejects.toThrow(/reason/i);
  const r = await reopenPeriod(c.id, "correcting a mis-keyed invoice");
  expect(r.status).toBe("REOPENED");
});
```

- [ ] **Step 2: Run red.**

```bash
npx vitest run tests/close-periods.test.ts -t "closes a clean month"
```

Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement `close-periods.ts`.** Compute the continuity schedule from live rows (invoices finalized with `invoiceDate` in the month; posted payments with `receivedDate` in the month; discount/write-off applications with `appliedDate` in the month; credits by `invoiceDate`), get `agingEndingAr` from `agingReport({ asOf: monthEnd })` summed in cents, and require reconciliation. `closePeriod` takes the month advisory lock (via `lockMonth`) inside a Serializable transaction so it serializes against concurrent postings (Task 4):

```ts
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors"; // match the existing helper import path
import { HttpError } from "./errors";
import { auditedCreate, auditedUpdate } from "./audit";
import { agingReport } from "./aging";
import { lockMonth } from "./period-locks";
import { formatDateOnly } from "@/lib/business-days";
import { currentActor } from "./context"; // Actor = { id: string | null; name: string }

const cents = (n: number) => Math.round(n * 100);

// NOTE (accepted, flag at the whole-branch review): `agingReport()` runs its own RepeatableRead
// transaction on a separate pooled connection — it takes no `tx`, so the endingAr (this tx) vs
// agingEndingAr (aging's read) variance is compared across two snapshots. This reconciles on
// clean data because every month dated <= periodEnd is either an already-CLOSED (locked) prior
// month or THIS month, which is held under the advisory lock during closePeriod — so no posting
// dated <= periodEnd can commit between the two reads. Do not "simplify" by dropping the aging
// side; the two independent derivations are the whole point of the reconciliation.

export type ContinuitySchedule = {
  beginningAr: number; invoicedTotal: number; creditTotal: number; paymentTotal: number;
  discountTotal: number; writeOffTotal: number; endingAr: number; agingEndingAr: number; variance: number;
};
export type ClosePeriodDetail = ContinuitySchedule & { id: string; year: number; month: number; status: string };
export type PreliminaryReport = {
  year: number; month: number; schedule: ContinuitySchedule;
  unpostedBatchCount: number; alreadyClosed: boolean;
};

function monthBounds(year: number, month: number): { startStr: string; endStr: string; endDate: Date } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this month
  return { startStr: formatDateOnly(start), endStr: formatDateOnly(end), endDate: end };
}

async function priorEndingAr(tx: Prisma.TransactionClient, year: number, month: number): Promise<number> {
  const py = month === 1 ? year - 1 : year;
  const pm = month === 1 ? 12 : month - 1;
  const prior = await tx.closePeriod.findFirst({ where: { year: py, month: pm } });
  if (!prior) return 0;
  if (prior.status !== "CLOSED") throw new HttpError(409, `The prior period ${py}-${String(pm).padStart(2, "0")} is not closed`);
  return prior.endingAr.toNumber();
}

async function computeSchedule(tx: Prisma.TransactionClient, year: number, month: number): Promise<ContinuitySchedule> {
  const { startStr, endStr, endDate } = monthBounds(year, month);
  const start = new Date(startStr), end = new Date(endStr);
  const beginningAr = await priorEndingAr(tx, year, month);
  const invoices = await tx.invoice.findMany({
    where: { status: "FINALIZED", invoiceDate: { gte: start, lte: end } },
    select: { kind: true, total: true },
  });
  let invoicedTotal = 0, creditTotal = 0;
  for (const i of invoices) {
    if (i.kind === "CREDIT") creditTotal += Math.abs(i.total.toNumber());
    else invoicedTotal += i.total.toNumber();
  }
  const apps = await tx.application.findMany({
    where: { deletedAt: null, appliedDate: { gte: start, lte: end } },
    select: { type: true, amount: true },
  });
  let discountTotal = 0, writeOffTotal = 0;
  for (const a of apps) {
    if (a.type === "DISCOUNT") discountTotal += a.amount.toNumber();
    else if (a.type === "WRITE_OFF") writeOffTotal += a.amount.toNumber();
  }
  const payments = await tx.payment.findMany({
    where: { deletedAt: null, receivedDate: { gte: start, lte: end }, batch: { status: "POSTED", deletedAt: null } },
    select: { amount: true },
  });
  const paymentTotal = payments.reduce((s, p) => s + p.amount.toNumber(), 0);
  const endingAr = (cents(beginningAr) + cents(invoicedTotal) - cents(creditTotal) - cents(paymentTotal) - cents(discountTotal) - cents(writeOffTotal)) / 100;
  const rows = await agingReport({ asOf: formatDateOnly(endDate) });
  const agingEndingAr = rows.reduce((s, r) => s + cents(r.net), 0) / 100;
  const variance = (cents(endingAr) - cents(agingEndingAr)) / 100;
  return { beginningAr, invoicedTotal, creditTotal, paymentTotal, discountTotal, writeOffTotal, endingAr, agingEndingAr, variance };
}

export async function preliminaryReport(year: number, month: number): Promise<PreliminaryReport> {
  return withDbErrors({ entity: "Close period" }, () => prisma.$transaction(async (tx) => {
    const schedule = await computeSchedule(tx, year, month);
    const { startStr, endStr } = monthBounds(year, month);
    const unpostedBatchCount = await tx.receiptBatch.count({
      where: { status: "OPEN", deletedAt: null, payments: { some: { deletedAt: null, receivedDate: { gte: new Date(startStr), lte: new Date(endStr) } } } },
    });
    const existing = await tx.closePeriod.findFirst({ where: { year, month } });
    return { year, month, schedule, unpostedBatchCount, alreadyClosed: existing?.status === "CLOSED" };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function closePeriod(year: number, month: number): Promise<ClosePeriodDetail> {
  return withDbErrors({ entity: "Close period" }, () => prisma.$transaction(async (tx) => {
    await lockMonth(tx, year, month); // serialize against concurrent postings + a concurrent close
    const schedule = await computeSchedule(tx, year, month);
    if (cents(schedule.variance) !== 0) {
      throw new HttpError(409, `The close does not reconcile — ending A/R ${schedule.endingAr} vs aging ${schedule.agingEndingAr}`);
    }
    const existing = await tx.closePeriod.findFirst({ where: { year, month } });
    const data = { year, month, status: "CLOSED", closedById: currentActor().id, reopenedAt: null,
      beginningAr: schedule.beginningAr, invoicedTotal: schedule.invoicedTotal, creditTotal: schedule.creditTotal,
      paymentTotal: schedule.paymentTotal, discountTotal: schedule.discountTotal, writeOffTotal: schedule.writeOffTotal,
      endingAr: schedule.endingAr, agingEndingAr: schedule.agingEndingAr };
    const row = existing
      ? await auditedUpdate("closePeriod", existing.id, () => tx.closePeriod.update({ where: { id: existing.id }, data }), { tx })
      : await auditedCreate("closePeriod", data, () => tx.closePeriod.create({ data }), { tx });
    return { id: row.id, year, month, status: "CLOSED", ...schedule };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export async function reopenPeriod(id: string, reason: string): Promise<ClosePeriodDetail> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to reopen a period");
  return withDbErrors({ entity: "Close period" }, () => prisma.$transaction(async (tx) => {
    const existing = await tx.closePeriod.findFirst({ where: { id } });
    if (!existing) throw new HttpError(404, "Close period not found");
    await lockMonth(tx, existing.year, existing.month);
    const row = await auditedUpdate("closePeriod", id,
      () => tx.closePeriod.update({ where: { id }, data: { status: "REOPENED", reopenedAt: new Date(), reopenReason: why } }), { tx });
    return { id: row.id, year: row.year, month: row.month, status: "REOPENED",
      beginningAr: row.beginningAr.toNumber(), invoicedTotal: row.invoicedTotal.toNumber(), creditTotal: row.creditTotal.toNumber(),
      paymentTotal: row.paymentTotal.toNumber(), discountTotal: row.discountTotal.toNumber(), writeOffTotal: row.writeOffTotal.toNumber(),
      endingAr: row.endingAr.toNumber(), agingEndingAr: row.agingEndingAr.toNumber(), variance: 0 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
```

*Note for the implementer:* match the exact import path/name the repo uses for `withDbErrors` and `prisma` (5B's `receipts.ts`/`invoices.ts` show them — the module token may differ). `currentActor().id` and `formatDateOnly` are verified correct (`context.ts`, `business-days.ts`). Do not invent new helpers.

- [ ] **Step 4: Run the close tests green.**

```bash
npx vitest run tests/close-periods.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the two concurrency RED tests** (spec §12), following the 5B two-interleaved-transactions-on-separate-clients shape, each **RED-verified by removing `lockMonth`**:
  1. **A posting racing a close.** A `finalizeInvoice` for a July-dated invoice interleaved with `closePeriod(2026, 7)`, the competitor pinned to Read Committed — assert the two serialize (the finalize either lands before the close and is counted, or is refused as period-closed), never both-commit-into-a-closed-month. (The apply/void variants §12 names share the same guard; a comment noting they're covered by the same `assertPeriodOpen` lock is sufficient once finalize is proven.)
  2. **Two closes of one month.** Two concurrent `closePeriod(2026, 7)` calls — assert exactly one `CLOSED` row exists afterward and neither call errors on a duplicate write. Without `lockMonth` both `findFirst`→null→`create` and one hits the `@@unique([year,month])` violation; with it they serialize (the second sees the first's row and updates it). Verify RED by removing `lockMonth` and watching the duplicate/violation.

- [ ] **Step 6: Add the routes.** Both `close_ar_period` and `run_qbo_export` **already exist** in `src/lib/permission-constants.ts`'s `SPECIAL_ACTIONS` and are granted to admin via `ALL_PERMISSIONS` (`tests/permissions.test.ts:43`) — no declaration or seed step is needed; a `grep close_ar_period src/lib/permission-constants.ts` confirms it before wiring. `close/preliminary/route.ts` (GET, `receivables.view`, `?year=&month=`), `close/route.ts` (POST, `close_ar_period`, body `{year,month}`), `close/[id]/reopen/route.ts` (POST, `close_ar_period`, body `{reason}`):

```ts
// close/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { closePeriod } from "@/server/close-periods";

const BODY = z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) }).strict();

export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "receivables", "edit");
  mustDo(user, "close_ar_period");
  const { year, month } = BODY.parse(await req.json());
  return NextResponse.json(await closePeriod(year, month));
});
```

Write `preliminary/route.ts` and `[id]/reopen/route.ts` in the same shape (preliminary parses `year`/`month` from the URL and gates `receivables.view`; reopen parses `{ reason }` and gates `close_ar_period`, reading the id from `ctx.params`).

- [ ] **Step 7: Add the route permission-ladder tests** to `receivables-routes.test.ts` (401/403/200, per the existing pattern with `signInWith`/`withParams`). Include a 200 close + a `close_ar_period`-missing 403.

- [ ] **Step 8: Run gates + E2E is deferred to Task 8 (no UI yet).**

```bash
npx vitest run tests/close-periods.test.ts tests/receivables-routes.test.ts
npx tsc --noEmit && npx eslint src tests
```

- [ ] **Step 9: Commit.**

```bash
git add erp/src/server/close-periods.ts erp/src/app/api/receivables/close erp/tests/close-periods.test.ts erp/tests/receivables-routes.test.ts
git commit -m "feat(5c): month-end close/reopen lifecycle, aging reconciliation, preliminary report + routes"
```

---

