// A LEAF, deliberately — the invoice-guards.ts / order-locks.ts / errors.ts precedent (Phase 4
// lesson 3; a `const` consumed across a module cycle crashes at module-evaluation time two tasks
// after the edge is added, so pull the shared question into a leaf BEFORE the cycle exists). Every
// A/R posting mutation — finalize/unlock/createCredit in invoices.ts, postBatch/voidPayment in
// receipts.ts, applyPayment/applyCredit/voidApplication in applications.ts — must be able to ask
// "is this month closed?" without any of them importing close-periods.ts (Task 5), which will
// import them. This module imports only `type Prisma` and the `HttpError` leaf; the import-shape
// test in tests/period-locks.test.ts pins that.
//
// THE CONCURRENCY DESIGN (load-bearing — do not reduce to a plain `findFirst`). The guarded fact is
// the *absence* of a CLOSED `ClosePeriod` row for the month: an un-closed month has NO row at all
// (spec §4.1), and no `SELECT … FOR UPDATE` can claim a row that does not exist. So both this guard
// and the close (Task 5) take a transaction-level Postgres advisory lock keyed on (year, month)
// BEFORE reading/writing. A finalize/apply/void and a concurrent close of the same month then
// serialize on that advisory lock at ANY isolation — closing the phantom the row-claim rule cannot,
// because there is no row to claim. It is defense-in-depth on top of both sides already running
// Serializable; the RED-verified concurrency test proves the lock, not SSI, is what serializes them.
import type { Prisma } from "../../prisma/generated/prisma/client";
import { HttpError } from "./errors";

export type ClosePeriodRef = { id: string; year: number; month: number };

/** The (year, month) a glDate falls in. UTC getters to match the UTC-midnight `@db.Date` reading
 *  every A/R date round-trips through (`todayDateOnly`/`parseDateOnly`, business-days.ts). */
function ym(glDate: Date): { year: number; month: number } {
  return { year: glDate.getUTCFullYear(), month: glDate.getUTCMonth() + 1 };
}

/**
 * Transaction-level advisory lock on a (year, month). Both this module's guard and Task 5's close
 * take it, so a posting mutation and a close of the same month serialize even when the ClosePeriod
 * row is absent. The `(4200, key)` two-int form namespaces the lock so it cannot collide with any
 * other advisory lock the app might take; `4200` is this module's classifier and `year * 100 +
 * month` (e.g. 202607) is the month key. `pg_advisory_xact_lock` releases automatically at
 * transaction end — no unlock call, no leak on a rollback.
 */
export async function lockMonth(tx: Prisma.TransactionClient, year: number, month: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(4200, ${year * 100 + month})`;
}

/** The CLOSED ClosePeriod covering glDate, or null. Takes the month lock FIRST, then reads — so the
 *  read, and the write the caller makes after it, cannot interleave with a concurrent close of the
 *  same month. A REOPENED row is not CLOSED and does not block (§4.1). */
export async function closedPeriodFor(tx: Prisma.TransactionClient, glDate: Date): Promise<ClosePeriodRef | null> {
  const { year, month } = ym(glDate);
  await lockMonth(tx, year, month);
  const row = await tx.closePeriod.findFirst({
    where: { year, month, status: "CLOSED" },
    select: { id: true, year: true, month: true },
  });
  return row;
}

/**
 * Throw 409 if glDate falls in a CLOSED month. Call UNDER the caller's existing row claim
 * (`claimOrder`/`claimInvoiceRow`/`claimLiveBatch`/`claimOrdersInOrder`) and BEFORE the audited
 * write, so the guard read and that write commit against one consistent state. Reads on the CALLER'S
 * OWN `tx`; it throws its own `HttpError` but checks no permission and takes no service dependency —
 * that is what keeps it a leaf importable from anywhere.
 */
export async function assertPeriodOpen(tx: Prisma.TransactionClient, glDate: Date): Promise<void> {
  const closed = await closedPeriodFor(tx, glDate);
  if (closed) {
    const mm = String(closed.month).padStart(2, "0");
    throw new HttpError(409,
      `The accounting period ${closed.year}-${mm} is closed — reopen it to make this change`);
  }
}
