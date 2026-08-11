## Task 4: `period-locks.ts` leaf + wiring into every 5A/5B posting mutation

**Files:**
- Create: `erp/src/server/period-locks.ts`
- Modify: `erp/src/server/invoices.ts`, `erp/src/server/receipts.ts`, `erp/src/server/applications.ts`
- Test: `erp/tests/period-locks.test.ts`

**Interfaces:**
- Consumes: `HttpError` from `errors.ts` (a leaf — importing it keeps `period-locks.ts` a leaf), `type Prisma`.
- Produces: `lockMonth(tx, year, month)` (consumed by `close-periods.ts` Task 5), `assertPeriodOpen(tx, glDate)`, `closedPeriodFor(tx, glDate)`.

**The concurrency design (load-bearing — do not reduce to a plain `findFirst`).** The guarded fact is the *absence* of a CLOSED `ClosePeriod` row for the month (an un-closed month has no row, spec §4.1), which no `SELECT … FOR UPDATE` can claim. So both the guard and the close take a **transaction-level Postgres advisory lock keyed on `(year, month)`** before reading/writing. This serializes a finalize/apply/void against a concurrent close of the same month at any isolation, closing the phantom the row-claim rule can't. It is defense-in-depth on top of both sides already being Serializable, and the RED test in Step 7 proves it.

- [ ] **Step 1: Write the failing guard test.** Create `erp/tests/period-locks.test.ts`:

```ts
import { beforeEach, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";
import { assertPeriodOpen, closedPeriodFor } from "@/server/period-locks";

beforeEach(truncateAll);

async function closeMonth(year: number, month: number) {
  return prisma.closePeriod.create({
    data: { year, month, beginningAr: 0, invoicedTotal: 0, creditTotal: 0, paymentTotal: 0,
      discountTotal: 0, writeOffTotal: 0, endingAr: 0, agingEndingAr: 0 },
  });
}

it("refuses a date inside a CLOSED month, allows an open month", async () => {
  await closeMonth(2026, 7);
  await prisma.$transaction(async (tx) => {
    await expect(assertPeriodOpen(tx, new Date("2026-07-15"))).rejects.toThrow(/closed/i);
    await assertPeriodOpen(tx, new Date("2026-08-01")); // no throw
  });
});

it("a REOPENED month is open again", async () => {
  const p = await closeMonth(2026, 7);
  await prisma.closePeriod.update({ where: { id: p.id }, data: { status: "REOPENED" } });
  await prisma.$transaction(async (tx) => {
    await assertPeriodOpen(tx, new Date("2026-07-15")); // no throw
    expect(await closedPeriodFor(tx, new Date("2026-07-15"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it red.**

```bash
npx vitest run tests/period-locks.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `period-locks.ts`** (leaf — imports only `type Prisma` and the `HttpError` leaf):

```ts
import type { Prisma } from "../../prisma/generated/prisma/client";
import { HttpError } from "./errors";

export type ClosePeriodRef = { id: string; year: number; month: number };

function ym(glDate: Date): { year: number; month: number } {
  return { year: glDate.getUTCFullYear(), month: glDate.getUTCMonth() + 1 };
}

/** Transaction-level advisory lock on a (year, month). Both the guard and the close take it, so a
 *  posting mutation and a close of the same month serialize even when the ClosePeriod row is absent. */
export async function lockMonth(tx: Prisma.TransactionClient, year: number, month: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(4200, ${year * 100 + month})`;
}

/** The CLOSED ClosePeriod covering glDate, or null. Takes the month lock first. */
export async function closedPeriodFor(tx: Prisma.TransactionClient, glDate: Date): Promise<ClosePeriodRef | null> {
  const { year, month } = ym(glDate);
  await lockMonth(tx, year, month);
  const row = await tx.closePeriod.findFirst({
    where: { year, month, status: "CLOSED" },
    select: { id: true, year: true, month: true },
  });
  return row;
}

/** Throw 409 if glDate falls in a CLOSED month. Call UNDER the caller's existing row claim. */
export async function assertPeriodOpen(tx: Prisma.TransactionClient, glDate: Date): Promise<void> {
  const closed = await closedPeriodFor(tx, glDate);
  if (closed) {
    const mm = String(closed.month).padStart(2, "0");
    throw new HttpError(409,
      `The accounting period ${closed.year}-${mm} is closed — reopen it to make this change`);
  }
}
```

- [ ] **Step 4: Add an import-shape test** (mirror `invoice-guards`'s pin) to `period-locks.test.ts`:

```ts
import { readFileSync } from "node:fs";

it("stays a dependency-free leaf", () => {
  const src = readFileSync(new URL("../src/server/period-locks.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/from ["']\.\/(invoices|receipts|applications|orders|shippers|close-periods|gl-export)["']/);
  expect(src).not.toMatch(/\brequire\(|import\(/);
});
```

- [ ] **Step 5: Wire the guard into `invoices.ts`.** In `finalizeInvoiceInTx`, after the `needsPrice` refusal block and before `const actor = currentActor();`:

```ts
  await assertPeriodOpen(tx, invoice.invoiceDate);
```

In `unlockInvoiceInTx`, after the `hasReceivableActivity` check and before the `auditedUpdate`:

```ts
  await assertPeriodOpen(tx, invoice.invoiceDate);
```

In `createCredit`, after `const creditDate = todayDateOnly();` and before the `auditedCreate`:

```ts
  await assertPeriodOpen(tx, creditDate);
```

Add `import { assertPeriodOpen } from "./period-locks";` at the top. (`invoice.invoiceDate`/`creditDate` are already in hand under the claim — no extra select.)

- [ ] **Step 6: Wire the guard into `receipts.ts` and `applications.ts`.** In `receipts.ts` `postBatchInTx`, after the "already posted" refusal, add a read of the batch's payments and guard per distinct received date (a POSTED batch's payments are the cash events):

```ts
  const dates = await tx.payment.findMany({
    where: { batchId: id, deletedAt: null }, select: { receivedDate: true },
  });
  for (const d of dates) await assertPeriodOpen(tx, d.receivedDate);
```

In `voidPaymentInTx`, add `receivedDate: true` to the payment `findFirst` select (currently `{ id: true }`), then after the live-application refusal and before the `auditedSoftDelete`:

```ts
  await assertPeriodOpen(tx, payment.receivedDate);
```

In `applications.ts` `applyPaymentInTx`, after `const appliedDate = payment.receivedDate;` and before the write loop:

```ts
  await assertPeriodOpen(tx, appliedDate);
```

In `applyCreditInTx`, after `const appliedDate = todayDateOnly();`:

```ts
  await assertPeriodOpen(tx, appliedDate);
```

In `voidApplicationInTx`, add `appliedDate: true` to the live re-read select, then before the `auditedSoftDelete`:

```ts
  await assertPeriodOpen(tx, live.appliedDate);
```

Add the `import { assertPeriodOpen } from "./period-locks";` to both files.

- [ ] **Step 7: Add the RED-verified concurrency test.** Append to `period-locks.test.ts` — prove a finalize into a month is refused once that month is closed, and (the real race) that the guard's advisory lock serializes a finalize against a concurrent close. First write the "post-close refusal" integration test using the real service:

```ts
import { finalizeInvoice } from "@/server/invoices";
// ... build a finalizable invoice dated in July via existing test factories ...
it("refuses finalizing an invoice dated in a closed month", async () => {
  const invoiceId = await makeFinalizableInvoiceDated("2026-07-10"); // helper per existing invoice tests
  await closeMonth(2026, 7);
  await expect(finalizeInvoice(invoiceId)).rejects.toThrow(/closed/i);
});
```

Then RED-verify: temporarily delete the `assertPeriodOpen` call in `finalizeInvoiceInTx` and confirm this test FAILS to throw; restore it. Document the RED run in the task report (a passing guard test is not evidence without it).

- [ ] **Step 8: Run gates.**

```bash
npx vitest run tests/period-locks.test.ts tests/invoices.test.ts tests/receipts.test.ts tests/applications.test.ts
npx tsc --noEmit && npx eslint src tests
```

Expected: PASS / clean. (The existing 5A/5B suites must stay green — the guard is a no-op when no month is closed.)

- [ ] **Step 9: Commit.**

```bash
git add erp/src/server/period-locks.ts erp/src/server/invoices.ts erp/src/server/receipts.ts erp/src/server/applications.ts erp/tests/period-locks.test.ts
git commit -m "feat(5c): period-lock leaf (advisory-locked) wired into every A/R posting mutation"
```

---

