import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors";
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
// SERIALIZATION IS THE ADVISORY LOCK, NOT THE ISOLATION LEVEL (period-locks.ts, Task 4). A close
// and any posting into the same month both take `lockMonth(year, month)` — a transaction-level
// Postgres advisory lock — so they serialize even though an un-closed month has NO ClosePeriod row
// to claim `FOR UPDATE` (the phantom the row-lock rule cannot close). Two concurrent closes of one
// month serialize on the same lock.
//
// ISOLATION: `closePeriod`/`reopenPeriod` run at READ COMMITTED (the default — no isolationLevel
// option), DELIBERATELY not Serializable. This is a considered departure from the task brief's
// sample, forced by a hard Postgres fact verified empirically before implementation: a Serializable
// (or RepeatableRead) transaction fixes its snapshot at its FIRST statement, and when that first
// statement is the BLOCKING `lockMonth` SELECT, the snapshot is taken BEFORE the lock is granted —
// so every read AFTER the lock is stale relative to whatever committed while we were blocked. Under
// Serializable the two concurrency acceptance criteria are unreachable: (a) the second of two
// concurrent closes unblocks with a stale snapshot, its `findFirst` misses the first close's
// just-committed row, it re-inserts and takes a serialization failure (P2034 → 409) instead of
// updating — it ERRORS, violating "neither call errors"; (b) a close that blocked behind a finalize
// unblocks stale, its schedule read misses the just-committed invoice, and it can only refuse on a
// spurious variance rather than counting it. READ COMMITTED gives each statement a FRESH snapshot,
// so the post-lock reads see exactly the committed state the advisory lock has frozen for the month
// — which is precisely what makes "the second sees the first's row and updates it" and "the close
// counts a finalize that landed first" both hold. The advisory lock supplies all the mutual
// exclusion; SSI would add nothing here (nothing can commit into the month while we hold the lock)
// and its stale-after-blocking-lock snapshot is the whole problem. `preliminaryReport` keeps its
// Serializable snapshot below because it takes NO lock — it never blocks, so it never reads stale.
//
// NOTE (accepted, flag at the whole-branch review): `agingReport()` runs its own RepeatableRead
// transaction on a SEPARATE pooled connection — it takes no `tx`, so `endingAr` (this tx) vs
// `agingEndingAr` (aging's read) is compared across two snapshots. This reconciles on clean data
// because every month dated <= periodEnd is either an already-CLOSED (locked) prior month or THIS
// month, which is held under the advisory lock during `closePeriod` — so no posting dated
// <= periodEnd can commit between the two reads. Do NOT "simplify" by dropping the aging side or by
// threading `tx` into `agingReport`; the two independent derivations are the whole point of the
// reconciliation.
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

/** The first and last calendar day of a month, at UTC midnight — matching the `@db.Date` reading
 *  every A/R date round-trips through. `Date.UTC(year, month, 0)` is day 0 of the NEXT month = the
 *  last day of this one. */
function monthBounds(year: number, month: number): { start: Date; end: Date; endStr: string } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { start, end, endStr: formatDateOnly(end) };
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

/**
 * The frozen continuity schedule for the month, derived from LIVE rows, plus the independent aging
 * cross-check. Flows are scoped by their A/R effective date: invoices/credits by `invoiceDate`,
 * payments by `receivedDate` (POSTED batches only), discount/write-off applications by
 * `appliedDate`. `endingAr` is the roll-forward; `agingEndingAr` is the aging net at period end
 * (spec §6); `variance` is their difference (integer cents), which `closePeriod` requires to be 0.
 */
async function computeSchedule(tx: Prisma.TransactionClient, year: number, month: number): Promise<ContinuitySchedule> {
  const { start, end, endStr } = monthBounds(year, month);
  const beginningAr = await priorEndingAr(tx, year, month);

  const invoices = await tx.invoice.findMany({
    where: { status: "FINALIZED", deletedAt: null, invoiceDate: { gte: start, lte: end } },
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
  const endingAr = endingCents / 100;

  // Independent derivation on its own connection (see the file header). Summed in cents.
  const rows = await agingReport({ asOf: endStr });
  const agingEndingAr = rows.reduce((s, r) => s + cents(r.net), 0) / 100;

  const variance = (endingCents - cents(agingEndingAr)) / 100;
  return { beginningAr, invoicedTotal, creditTotal, paymentTotal, discountTotal, writeOffTotal, endingAr, agingEndingAr, variance };
}

/**
 * The read-only preview (spec §4.1): the schedule + variance a user sees before committing the
 * close, the count of OPEN batches with a payment dated in the month (unposted cash that WOULD move
 * the numbers once posted), and whether the month is already CLOSED. Takes no advisory lock — it is
 * a preview, mutates nothing — so it runs Serializable purely for a consistent snapshot of its own
 * several reads; with no lock it never blocks and so never reads stale.
 */
export async function preliminaryReport(year: number, month: number): Promise<PreliminaryReport> {
  return withDbErrors({ entity: "Close period" }, () => prisma.$transaction(async (tx) => {
    const schedule = await computeSchedule(tx, year, month);
    const { start, end } = monthBounds(year, month);
    const unpostedBatchCount = await tx.receiptBatch.count({
      where: {
        status: "OPEN", deletedAt: null,
        payments: { some: { deletedAt: null, receivedDate: { gte: start, lte: end } } },
      },
    });
    const existing = await tx.closePeriod.findFirst({ where: { year, month } });
    return { year, month, schedule, unpostedBatchCount, alreadyClosed: existing?.status === "CLOSED" };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Close the month: take the single month advisory lock, compute + reconcile the schedule, and
 * freeze it in a CLOSED ClosePeriod row (creating it, or re-closing a REOPENED month by updating in
 * place). Refuses if the roll-forward disagrees with the aging (variance ≠ 0) or if the prior month
 * is not closed. Exactly ONE `lockMonth` (Task 4's invariant). Read Committed — see the file header.
 */
export async function closePeriod(year: number, month: number): Promise<ClosePeriodDetail> {
  return withDbErrors({ entity: "Close period" }, () => prisma.$transaction(async (tx) => {
    await lockMonth(tx, year, month); // serialize against concurrent postings AND a concurrent close
    const schedule = await computeSchedule(tx, year, month);
    if (cents(schedule.variance) !== 0) {
      throw new HttpError(409,
        `The close does not reconcile — ending A/R ${schedule.endingAr} vs aging ${schedule.agingEndingAr}`);
    }
    const existing = await tx.closePeriod.findFirst({ where: { year, month } });
    const data = {
      year, month, status: "CLOSED", closedById: currentActor().id, reopenedAt: null,
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
  }));
}

/**
 * Reopen a closed month (spec §4.1): flip it to REOPENED so a correction can be posted into it. The
 * reason is REQUIRED (non-empty once trimmed) and recorded both on the row and — via `auditedUpdate`
 * — in the audit entry. Takes the month's advisory lock so it serializes against postings and a
 * concurrent close of the same month. Read Committed, for the same reason as `closePeriod`.
 */
export async function reopenPeriod(id: string, reason: string): Promise<ClosePeriodDetail> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to reopen a period");
  return withDbErrors({ entity: "Close period" }, () => prisma.$transaction(async (tx) => {
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
  }));
}
