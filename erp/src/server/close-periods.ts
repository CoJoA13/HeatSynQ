import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { withDbErrors, retryOnSerializationConflict } from "./db-errors";
import { HttpError } from "./errors";
import { auditedCreate, auditedUpdate } from "./audit";
import { agingReport } from "./aging";
import { lockMonth } from "./period-locks";
import { formatDateOnly } from "../lib/business-days";
import { currentActor } from "./context";

// -------------------------------------------------------------------------------------------
// Task 5 (P5C §4.1): the month-end close/reopen lifecycle. A ClosePeriod row FREEZES a month's
// A/R continuity schedule (beginning + invoiced − credits − payments − discounts − write-offs =
// ending) and reconciles that ending against an INDEPENDENT derivation — the aging net at the
// period end — refusing to close if the two disagree (§6 variance). `preliminaryReport` is the
// read-only preview; `closePeriod` commits the frozen row; `reopenPeriod` flips it back to
// REOPENED with a mandatory reason so a correction can be posted.
//
// TWO SERIALIZERS, BOTH LOAD-BEARING — the month advisory lock AND Serializable isolation.
// `closePeriod`/`reopenPeriod` and every A/R posting into the same month both take `lockMonth(year,
// month)` (period-locks.ts, Task 4) — a transaction-level Postgres advisory lock — so they serialize
// even though an un-closed month has NO ClosePeriod row to claim `FOR UPDATE` (the phantom the
// row-lock rule cannot close). Two concurrent closes of one month serialize on that same lock.
//
// The advisory lock is NOT sufficient on its own, and this is the fix for the posting-vs-close leak.
// A posting (`finalizeInvoice` et al.) runs Serializable and fixes its snapshot at `claimInvoiceRow`
// — BEFORE it reaches `assertPeriodOpen`'s `lockMonth`. If a close commits its CLOSED row after that
// snapshot, the posting's period read (a plain `findFirst`, no `FOR UPDATE`) misses it on the fixed
// snapshot and would post into the just-closed month. The advisory lock cannot stop this: it only
// orders the two, it does not make the posting re-read. What catches it is SSI — but ONLY if the
// close is ALSO Serializable, so the posting's read of "month open" and the close's insert of the
// CLOSED row form the rw-antidependency Postgres aborts (40001). A Read-Committed close is invisible
// to SSI and the posting leaks in. So `closePeriod`/`reopenPeriod` run Serializable: SSI is the
// backstop for the posting side; the advisory lock orders the closes.
//
// The cost Serializable imposes on the CLOSE side — the loser of two concurrent closes unblocks with
// a snapshot fixed BEFORE the winner committed (the blocking `lockMonth` SELECT takes the snapshot
// before the lock is granted), so its `findFirst` misses the winner's row and its insert collides —
// is absorbed by `retryOnSerializationConflict`: the re-run gets a fresh snapshot, sees the committed
// row, and takes the `existing ? update : create` UPDATE branch. Wrapping the RAW `$transaction`
// (inside `withDbErrors`, before it translates the raw error) is what lets the retry see the P2034 /
// P2002 conflict. We DELIBERATELY give up the old Read-Committed behavior where a close that blocked
// behind a finalize could still count it in the same instant: under Serializable that close reads a
// stale roll-forward and refuses on a variance (a safe 409 the operator re-runs) — closing the leak
// is worth that. `preliminaryReport` keeps its Serializable snapshot below and needs no retry: it
// takes NO lock and writes nothing, so it never blocks and never collides.
//
// AGING IS READ OUTSIDE THE CLOSE/PREVIEW TRANSACTION (P2024 pool-starvation fix, whole-branch
// review). `agingReport()` opens its OWN RepeatableRead transaction on a SEPARATE pooled connection
// (it takes no `tx`). Reading it while the outer Serializable close/preview transaction still holds
// ITS connection is the connection-held-while-acquiring-a-second antipattern — under concurrent
// close-screen load every close held one connection while waiting for a second, starving the pool.
// So `preliminaryReport`/`closePeriod` read the aging FIRST (its connection is fully released), THEN
// open the roll-forward transaction: `computeRollForward` (the tx) and the aging (its own read) are
// two INDEPENDENT derivations of the same net A/R that the variance reconciles. Correctness holds
// because a posting can only ever make the two DISAGREE (the roll-forward would include an event the
// pre-read aging missed) -> a SAFE variance 409 the operator re-runs, never a false reconcile; and
// once the close's CLOSED row lands, `assertPeriodOpen` blocks every further posting dated in the
// month, so the frozen figures cannot drift afterward. Do NOT "simplify" by dropping the aging side,
// by threading `tx` into `agingReport` (that re-nests the second connection), or by moving the aging
// read back inside the transaction.
//
// RECOGNITION BASIS = `finalizedAt` (owner ruling 8, 2026-08-10). An invoice/credit counts in the
// month it is FINALIZED, not its document `invoiceDate` — 5B's aging already includes an invoice by
// `finalizedAt`, so the roll-forward MUST scope finalized invoices/credits by `finalizedAt` too or a
// July-dated / August-finalized invoice (the ordinary month-end pattern) makes BOTH months fail to
// reconcile. `finalizedAt` is a plain `DateTime` (time-of-day, unlike the @db.Date document dates),
// and the aging compares it by its DATE part, so the scope is the HALF-OPEN interval
// `[monthStart, nextMonthStart)` — a timestamp anywhere on the last day is still in-month. Payments
// stay `receivedDate`, applications stay `appliedDate` (both @db.Date, `[start, end]` inclusive).
// -------------------------------------------------------------------------------------------

const cents = (n: number): number => Math.round(n * 100);

export type ContinuitySchedule = {
  beginningAr: number; invoicedTotal: number; creditTotal: number; paymentTotal: number;
  discountTotal: number; writeOffTotal: number; endingAr: number; agingEndingAr: number; variance: number;
};
export type ClosePeriodDetail = ContinuitySchedule & { id: string; year: number; month: number; status: string };
export type PreliminaryReport = {
  year: number; month: number; schedule: ContinuitySchedule;
  unpostedBatchCount: number; alreadyClosed: boolean;
};
export type ClosePeriodListItem = ContinuitySchedule & {
  id: string; year: number; month: number; status: string; closedAt: string;
  exportBatches: { id: string; exportNumber: number; emittedAt: string; fileName: string }[];
};

/** The first and last calendar day of a month, at UTC midnight — matching the `@db.Date` reading
 *  every A/R date round-trips through. `Date.UTC(year, month, 0)` is day 0 of the NEXT month = the
 *  last day of this one; `Date.UTC(year, month, 1)` is the 1st of the next month — the EXCLUSIVE
 *  upper bound for a `finalizedAt` scope (a plain `DateTime`, so a same-day timestamp with a
 *  time-of-day is still in-month only under a half-open `[start, next)` interval). */
function monthBounds(year: number, month: number): { start: Date; end: Date; next: Date; endStr: string } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  const next = new Date(Date.UTC(year, month, 1));
  return { start, end, next, endStr: formatDateOnly(end) };
}

/**
 * The month's BEGINNING A/R (spec §4.1, ruling 5 "chain from zero"): the prior month's frozen
 * `endingAr` when it is CLOSED, else $0 — but only when this is genuinely a first/genesis close.
 *
 * The close "requires the prior month closed (or this is the first close)" (spec §4.1, line 107).
 * "First close" is chain-from-zero genesis: it is legitimate to make the FIRST close of the system
 * any month and begin it at $0 (no opening-balance entry is built — ruling 5). So a missing prior
 * month is allowed ONLY when nothing earlier is closed; if an EARLIER month is already closed but
 * the immediately-prior month is not, a month is being SKIPPED and the chain would break — refuse.
 * A REOPENED prior month is not CLOSED and blocks too. (This departs from the task brief's sample,
 * which returned $0 for any missing prior and so could neither refuse a skipped month nor let its
 * own "refuses" test reach a refusal; the spec's rule is the binding one.)
 */
async function priorEndingAr(tx: Prisma.TransactionClient, year: number, month: number): Promise<number> {
  const py = month === 1 ? year - 1 : year;
  const pm = month === 1 ? 12 : month - 1;
  const pmStr = `${py}-${String(pm).padStart(2, "0")}`;
  const prior = await tx.closePeriod.findFirst({ where: { year: py, month: pm } });
  if (prior) {
    if (prior.status !== "CLOSED") throw new HttpError(409, `The prior period ${pmStr} is not closed`);
    return prior.endingAr.toNumber();
  }
  // No prior-month row: allowed only as the genesis close — nothing STRICTLY earlier is closed.
  const earlierClose = await tx.closePeriod.findFirst({
    where: { OR: [{ year: { lt: year } }, { year, month: { lt: month } }] },
    select: { id: true },
  });
  if (earlierClose) throw new HttpError(409, `The prior period ${pmStr} is not closed`);
  return 0;
}

/** The roll-forward figures ONLY (no aging, no variance) — read on the CALLER'S `tx`, under its month
 *  lock. `endingCents` is carried alongside `endingAr` so the caller reconciles in integer cents. */
type RollForward = {
  beginningAr: number; invoicedTotal: number; creditTotal: number; paymentTotal: number;
  discountTotal: number; writeOffTotal: number; endingAr: number; endingCents: number;
};

/**
 * The month's A/R roll-forward from LIVE rows, on the caller's `tx`. Flows are scoped by their A/R
 * effective date: finalized invoices/credits by **`finalizedAt`** (owner ruling 8 — the finalize
 * month, matching 5B's aging; the HALF-OPEN `[start, next)` interval because `finalizedAt` is a
 * `DateTime` with a time-of-day, unlike the @db.Date document dates), payments by `receivedDate`
 * (POSTED batches only), discount/write-off applications by `appliedDate` (both @db.Date,
 * `[start, end]` inclusive). Does NOT read the aging — the caller reconciles against
 * `agingEndingArAt`, read on its own connection OUTSIDE the transaction (see the file header).
 */
async function computeRollForward(tx: Prisma.TransactionClient, year: number, month: number): Promise<RollForward> {
  const { start, end, next } = monthBounds(year, month);
  const beginningAr = await priorEndingAr(tx, year, month);

  const invoices = await tx.invoice.findMany({
    where: { status: "FINALIZED", deletedAt: null, finalizedAt: { gte: start, lt: next } },
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
    where: {
      deletedAt: null, receivedDate: { gte: start, lte: end },
      batch: { status: "POSTED", deletedAt: null },
    },
    select: { amount: true },
  });
  const paymentTotal = payments.reduce((s, p) => s + p.amount.toNumber(), 0);

  // Integer-cents arithmetic throughout (the shared rounding rule) — the roll-forward identity.
  const endingCents = cents(beginningAr) + cents(invoicedTotal) - cents(creditTotal)
    - cents(paymentTotal) - cents(discountTotal) - cents(writeOffTotal);
  return {
    beginningAr, invoicedTotal, creditTotal, paymentTotal, discountTotal, writeOffTotal,
    endingAr: endingCents / 100, endingCents,
  };
}

/** The aging net at the period end (spec §6), on aging's OWN pooled connection. Called OUTSIDE the
 *  close/preview transaction so no connection is held while this second one is acquired (the P2024
 *  pool-starvation fix — see the file header). Summed in cents. */
async function agingEndingArAt(endStr: string): Promise<number> {
  const rows = await agingReport({ asOf: endStr });
  return rows.reduce((s, r) => s + cents(r.net), 0) / 100;
}

/** Assemble the frozen continuity schedule + the reconciliation variance (integer cents) from the
 *  roll-forward (the transaction) and the aging net (its own read). `closePeriod` requires
 *  `variance === 0`. */
function scheduleFrom(rf: RollForward, agingEndingAr: number): ContinuitySchedule {
  const variance = (rf.endingCents - cents(agingEndingAr)) / 100;
  return {
    beginningAr: rf.beginningAr, invoicedTotal: rf.invoicedTotal, creditTotal: rf.creditTotal,
    paymentTotal: rf.paymentTotal, discountTotal: rf.discountTotal, writeOffTotal: rf.writeOffTotal,
    endingAr: rf.endingAr, agingEndingAr, variance,
  };
}

/**
 * The read-only preview (spec §4.1): the schedule + variance a user sees before committing the
 * close, the count of OPEN batches with a payment dated in the month (unposted cash that WOULD move
 * the numbers once posted), and whether the month is already CLOSED. Takes no advisory lock — it is
 * a preview, mutates nothing — so its transaction runs Serializable purely for a consistent snapshot
 * of its own several reads; with no lock it never blocks and so never reads stale. The aging is read
 * BEFORE the transaction opens (its own connection, released first) — the pool-starvation fix.
 */
export async function preliminaryReport(year: number, month: number): Promise<PreliminaryReport> {
  return withDbErrors({ entity: "Close period" }, async () => {
    // Aging FIRST, on its own connection — fully released before the preview transaction opens (the
    // P2024 pool-starvation fix). A preview read: nothing is written, no lock is taken.
    const { start, end, endStr } = monthBounds(year, month);
    const agingEndingAr = await agingEndingArAt(endStr);
    return prisma.$transaction(async (tx) => {
      const schedule = scheduleFrom(await computeRollForward(tx, year, month), agingEndingAr);
      const unpostedBatchCount = await tx.receiptBatch.count({
        where: {
          status: "OPEN", deletedAt: null,
          payments: { some: { deletedAt: null, receivedDate: { gte: start, lte: end } } },
        },
      });
      const existing = await tx.closePeriod.findFirst({ where: { year, month } });
      return { year, month, schedule, unpostedBatchCount, alreadyClosed: existing?.status === "CLOSED" };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });
}

/**
 * Close the month: take the single month advisory lock, compute + reconcile the schedule, and
 * freeze it in a CLOSED ClosePeriod row (creating it, or re-closing a REOPENED month by updating in
 * place — clearing the stale reopen note). Refuses if the roll-forward disagrees with the aging
 * (variance ≠ 0) or if the prior month is not closed. Exactly ONE `lockMonth` (Task 4's invariant).
 * Serializable + `retryOnSerializationConflict` — SSI backstops the posting side, the retry absorbs
 * the two-close conflict (see the file header).
 */
export async function closePeriod(year: number, month: number): Promise<ClosePeriodDetail> {
  const { endStr } = monthBounds(year, month);
  return withDbErrors({ entity: "Close period" }, () => retryOnSerializationConflict(async () => {
    // Aging FIRST, on its own connection — released before the close transaction opens (the P2024
    // pool-starvation fix, file header). Inside the retry so a serialization re-run re-reads it fresh.
    const agingEndingAr = await agingEndingArAt(endStr);
    return prisma.$transaction(async (tx) => {
      await lockMonth(tx, year, month); // serialize against concurrent postings AND a concurrent close
      const schedule = scheduleFrom(await computeRollForward(tx, year, month), agingEndingAr);
      if (cents(schedule.variance) !== 0) {
        throw new HttpError(409,
          `The close does not reconcile — ending A/R ${schedule.endingAr} vs aging ${schedule.agingEndingAr} (off by ${schedule.variance})`);
      }
      const existing = await tx.closePeriod.findFirst({ where: { year, month } });
      const data = {
        year, month, status: "CLOSED", closedById: currentActor().id, reopenedAt: null, reopenReason: "",
        beginningAr: schedule.beginningAr, invoicedTotal: schedule.invoicedTotal, creditTotal: schedule.creditTotal,
        paymentTotal: schedule.paymentTotal, discountTotal: schedule.discountTotal, writeOffTotal: schedule.writeOffTotal,
        endingAr: schedule.endingAr, agingEndingAr: schedule.agingEndingAr,
      };
      const row = existing
        ? await auditedUpdate("closePeriod", existing.id,
            () => tx.closePeriod.update({ where: { id: existing.id }, data }), { tx })
        : await auditedCreate("closePeriod", data,
            () => tx.closePeriod.create({ data }), { tx });
      return { id: row.id, year, month, status: "CLOSED", ...schedule };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }));
}

/**
 * Task 8's own gap: nothing listed the closed periods + their GL-export batches before this — the
 * `/receivables/close` screen's closed-periods panel needs it, and there was no route for it.
 * Every ClosePeriod row (CLOSED and REOPENED, newest first), with its frozen schedule figures and
 * every `GlExportBatch` emitted against it (newest export first). A plain read: no lock, no
 * isolation requirement, nothing to translate — matches `listBatches` (receipts.ts), not the
 * Serializable+lock shape below. `variance` is recomputed for display only (`endingAr -
 * agingEndingAr`, always 0 for a genuinely CLOSED row since `closePeriod` refuses a nonzero one) —
 * it is not a stored column.
 */
export async function listClosePeriods(): Promise<ClosePeriodListItem[]> {
  const rows = await prisma.closePeriod.findMany({
    orderBy: [{ year: "desc" }, { month: "desc" }],
    include: {
      exportBatches: {
        orderBy: { exportNumber: "desc" },
        select: { id: true, exportNumber: true, emittedAt: true, fileName: true },
      },
    },
  });
  return rows.map((r) => {
    const endingAr = r.endingAr.toNumber();
    const agingEndingAr = r.agingEndingAr.toNumber();
    return {
      id: r.id, year: r.year, month: r.month, status: r.status, closedAt: r.closedAt.toISOString(),
      beginningAr: r.beginningAr.toNumber(), invoicedTotal: r.invoicedTotal.toNumber(),
      creditTotal: r.creditTotal.toNumber(), paymentTotal: r.paymentTotal.toNumber(),
      discountTotal: r.discountTotal.toNumber(), writeOffTotal: r.writeOffTotal.toNumber(),
      endingAr, agingEndingAr, variance: endingAr - agingEndingAr,
      exportBatches: r.exportBatches.map((b) => ({
        id: b.id, exportNumber: b.exportNumber, emittedAt: b.emittedAt.toISOString(), fileName: b.fileName,
      })),
    };
  });
}

/**
 * Reopen a closed month (spec §4.1): flip it to REOPENED so a correction can be posted into it. The
 * reason is REQUIRED (non-empty once trimmed) and recorded both on the row and — via `auditedUpdate`
 * — in the audit entry. Takes the month's advisory lock so it serializes against postings and a
 * concurrent close of the same month. Serializable + retry, for the same reason as `closePeriod`.
 */
export async function reopenPeriod(id: string, reason: string): Promise<ClosePeriodDetail> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to reopen a period");
  return withDbErrors({ entity: "Close period" }, () => retryOnSerializationConflict(() => prisma.$transaction(async (tx) => {
    const existing = await tx.closePeriod.findFirst({ where: { id } });
    if (!existing) throw new HttpError(404, "Close period not found");
    await lockMonth(tx, existing.year, existing.month);
    const row = await auditedUpdate("closePeriod", id,
      () => tx.closePeriod.update({
        where: { id }, data: { status: "REOPENED", reopenedAt: new Date(), reopenReason: why },
      }), { tx, reason: why });
    return {
      id: row.id, year: row.year, month: row.month, status: "REOPENED",
      beginningAr: row.beginningAr.toNumber(), invoicedTotal: row.invoicedTotal.toNumber(),
      creditTotal: row.creditTotal.toNumber(), paymentTotal: row.paymentTotal.toNumber(),
      discountTotal: row.discountTotal.toNumber(), writeOffTotal: row.writeOffTotal.toNumber(),
      endingAr: row.endingAr.toNumber(), agingEndingAr: row.agingEndingAr.toNumber(), variance: 0,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })));
}
