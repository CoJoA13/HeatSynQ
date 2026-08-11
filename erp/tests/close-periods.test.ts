import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { closePeriod, preliminaryReport, reopenPeriod } from "@/server/close-periods";
import { finalizeInvoice } from "@/server/invoices";
import { HttpError } from "@/server/errors";
import { parseDateOnly, todayDateOnly } from "@/lib/business-days";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(truncateAll);

it("can create a ClosePeriod, GlExportBatch, and GlPosting", async () => {
  const period = await prisma.closePeriod.create({
    data: {
      year: 2026, month: 7, beginningAr: 0, invoicedTotal: 100, creditTotal: 0,
      paymentTotal: 40, discountTotal: 0, writeOffTotal: 0, endingAr: 60, agingEndingAr: 60,
    },
  });
  const batch = await prisma.glExportBatch.create({
    data: {
      exportNumber: 1000, closePeriodId: period.id, periodEnd: new Date("2026-07-31"),
      fileName: "gl-2026-07.csv", file: new Uint8Array([1]), register: new Uint8Array([2]),
    },
  });
  await prisma.glPosting.create({
    data: {
      batchId: batch.id, sourceType: "INVOICE", sourceId: "x", glDate: new Date("2026-07-15"),
      debit: 100, credit: 0, side: "SALES",
    },
  });
  expect(await prisma.glPosting.count({ where: { batchId: batch.id } })).toBe(1);
});

// -------------------------------------------------------------------------------------------
// Task 5 (P5C §4.1/§6): the close/reopen lifecycle, the continuity schedule, and its
// roll-forward-vs-aging reconciliation. Factories build finalized invoices and posted payments
// directly (the applications-concurrency.test.ts pattern) so the schedule inputs are exact.
// -------------------------------------------------------------------------------------------

let seq = 0;
type InvoiceRef = { invoiceId: string; customerId: string };

async function makeFinalizedInvoiceDated(dateStr: string, total: number, finalizedAtStr?: string): Promise<InvoiceRef> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `CLP${seq}`, name: `Close Customer ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 750000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly(dateStr), requestDate: parseDateOnly(dateStr),
    },
  });
  // `finalizedAtStr` defaults to `dateStr`, so most callers keep finalizedAt == invoiceDate. The
  // month-end straddle regression passes a DIFFERENT finalizedAt (ruling 8: recognition is by the
  // finalize month, not the document date). `dueDate` stays on `dateStr` (the invoice's own aging).
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly(dateStr), dueDate: parseDateOnly(dateStr),
      total, finalizedAt: parseDateOnly(finalizedAtStr ?? dateStr),
    },
  });
  return { invoiceId: invoice.id, customerId: customer.id };
}

/** A POSTED-batch payment fully applied to `inv` (a PAYMENT application), so the schedule's
 *  `paymentTotal` and the aging's reduced open balance both move by `amount`. */
async function payInvoiceDated(inv: InvoiceRef, dateStr: string, amount: number): Promise<void> {
  seq += 1;
  const paymentType = await prisma.paymentType.create({ data: { name: `PT-${seq}` } });
  const batch = await prisma.receiptBatch.create({
    data: { batchNumber: 850000 + seq, depositDate: parseDateOnly(dateStr), status: "POSTED" },
  });
  const payment = await prisma.payment.create({
    data: {
      batchId: batch.id, customerId: inv.customerId, paymentTypeId: paymentType.id,
      amount, receivedDate: parseDateOnly(dateStr),
    },
  });
  await prisma.application.create({
    data: {
      invoiceId: inv.invoiceId, amount, type: "PAYMENT", paymentId: payment.id,
      appliedDate: parseDateOnly(dateStr),
    },
  });
}

/** A finalizable DRAFT invoice (no unpriced lines) on its own order — the input the dangerous-
 *  direction concurrency test drives the REAL `finalizeInvoice` against. */
async function makeDraftInvoiceDated(dateStr: string, total: number): Promise<{ invoiceId: string; orderId: string }> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `CLPD${seq}`, name: `Draft Customer ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 770000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly(dateStr), requestDate: parseDateOnly(dateStr),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "DRAFT", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly(dateStr), total,
    },
  });
  return { invoiceId: invoice.id, orderId: order.id };
}

describe("close/reopen lifecycle", () => {
  it("closes a clean month: beginning 0, chains, reconciles to aging (variance 0)", async () => {
    const inv = await makeFinalizedInvoiceDated("2026-07-05", 100); // total 100
    await payInvoiceDated(inv, "2026-07-20", 40);                   // pay 40

    const prelim = await preliminaryReport(2026, 7);
    expect(prelim.schedule.beginningAr).toBe(0);
    expect(prelim.schedule.invoicedTotal).toBe(100);
    expect(prelim.schedule.paymentTotal).toBe(40);
    expect(prelim.schedule.endingAr).toBe(60);
    expect(prelim.schedule.variance).toBe(0); // endingAr === agingEndingAr
    expect(prelim.unpostedBatchCount).toBe(0);
    expect(prelim.alreadyClosed).toBe(false);

    const closed = await asSystem(() => closePeriod(2026, 7));
    expect(closed.status).toBe("CLOSED");
    expect(closed.endingAr).toBe(60);

    // Once closed, the preliminary report reflects it.
    expect((await preliminaryReport(2026, 7)).alreadyClosed).toBe(true);
  });

  it("chains beginning A/R from the prior close", async () => {
    await makeFinalizedInvoiceDated("2026-07-05", 100);
    await asSystem(() => closePeriod(2026, 7));
    await makeFinalizedInvoiceDated("2026-08-05", 30);
    const aug = await asSystem(() => closePeriod(2026, 8));
    expect(aug.beginningAr).toBe(100); // July's ending
    expect(aug.endingAr).toBe(130);
  });

  it("a FIRST close of any month begins at $0 (genesis / chain-from-zero, spec §4.1 + ruling 5)", async () => {
    // Documents the resolution of the brief's contradiction: closing August on an empty DB is a
    // valid genesis close (beginning $0), NOT a refusal — the refusal case is a skipped month below.
    await makeFinalizedInvoiceDated("2026-08-05", 30);
    const aug = await asSystem(() => closePeriod(2026, 8));
    expect(aug.beginningAr).toBe(0);
    expect(aug.endingAr).toBe(30);
  });

  it("refuses to close a month whose prior month is not closed (a skipped month)", async () => {
    // Spec §4.1: the close "requires the prior month closed (or this is the first close)". After July
    // is closed, closing September leaves August (the prior month) unclosed — the chain would break.
    await makeFinalizedInvoiceDated("2026-07-05", 100);
    await asSystem(() => closePeriod(2026, 7));
    await makeFinalizedInvoiceDated("2026-09-05", 30);
    await expect(asSystem(() => closePeriod(2026, 9))).rejects.toThrow(/prior|previous|2026-08|August/i);
  });

  it("refuses a close whose roll-forward does not reconcile to the aging (variance named)", async () => {
    // A finalized June invoice never captured in a June close: closing July as the genesis rolls
    // forward from $0 and counts only July's activity, but the aging at 2026-07-31 still sees June's
    // open balance — the two derivations disagree, so the close is refused (spec §6).
    await makeFinalizedInvoiceDated("2026-06-15", 50);
    await makeFinalizedInvoiceDated("2026-07-05", 100);
    await expect(asSystem(() => closePeriod(2026, 7))).rejects.toThrow(/reconcile|variance|aging/i);
  });

  it("recognizes an invoice by finalizedAt, not invoiceDate (ruling 8 month-end straddle reconciles both months)", async () => {
    // The empirically-confirmed whole-branch defect: an invoice DATED the last day of July but
    // FINALIZED in early August — the ordinary month-end pattern. The aging includes it by finalizedAt
    // (August); the OLD invoiceDate-scoped roll-forward counted it in July, so July's roll-forward
    // ($100) diverged from July's aging ($0) AND August's from August's aging → BOTH months refused
    // (unclosable). Under the finalizedAt basis it is purely August activity: July reconciles to $0 and
    // August counts + reconciles it. This test FAILS on the old invoiceDate-scoped roll-forward
    // (July's variance would be 100, so `closePeriod(2026, 7)` would reject on /reconcile/).
    await makeFinalizedInvoiceDated("2026-07-31", 100, "2026-08-02");

    const july = await asSystem(() => closePeriod(2026, 7));
    expect(july.invoicedTotal).toBe(0);   // August activity — not counted in July
    expect(july.endingAr).toBe(0);
    expect(july.variance).toBe(0);         // reconciles: the invoice is absent from both derivations

    const aug = await asSystem(() => closePeriod(2026, 8));
    expect(aug.beginningAr).toBe(0);       // July ended at $0 (chain)
    expect(aug.invoicedTotal).toBe(100);   // recognized in its finalize month
    expect(aug.endingAr).toBe(100);
    expect(aug.variance).toBe(0);          // aging at 2026-08-31 includes it too → reconciles
  });

  it("reopen requires a reason, flips status, and records the reason in the audit entry", async () => {
    await makeFinalizedInvoiceDated("2026-07-05", 100);
    const c = await asSystem(() => closePeriod(2026, 7));
    await expect(asSystem(() => reopenPeriod(c.id, "  "))).rejects.toThrow(/reason/i);

    const r = await asSystem(() => reopenPeriod(c.id, "correcting a mis-keyed invoice"));
    expect(r.status).toBe("REOPENED");

    const entry = await prisma.auditLog.findFirst({
      where: { entity: "closePeriod", entityId: c.id, action: "update" },
      orderBy: { at: "desc" },
    });
    expect(entry?.reason).toBe("correcting a mis-keyed invoice");

    // A reopened month is open again — it can be re-closed (the prior-month check treats it as the
    // genesis it was, and the row is updated in place, not duplicated).
    const reclosed = await asSystem(() => closePeriod(2026, 7));
    expect(reclosed.status).toBe("CLOSED");
    expect(reclosed.id).toBe(c.id);
    expect(await prisma.closePeriod.count({ where: { year: 2026, month: 7 } })).toBe(1);
  });

  it("refreshes closedAt on re-close of a reopened month (not the stale original close time)", async () => {
    await makeFinalizedInvoiceDated("2026-07-05", 100);
    await asSystem(() => closePeriod(2026, 7));
    const first = await prisma.closePeriod.findFirstOrThrow({ where: { year: 2026, month: 7 } });

    await asSystem(() => reopenPeriod(first.id, "correcting"));
    const reopened = await prisma.closePeriod.findFirstOrThrow({ where: { id: first.id } });

    await asSystem(() => closePeriod(2026, 7));
    const reclosed = await prisma.closePeriod.findFirstOrThrow({ where: { id: first.id } });

    // closedAt defaults on INSERT only; the re-close UPDATEs the row in place. It must advance to the
    // re-close time — the pre-fix bug left it at the ORIGINAL close, which is strictly BEFORE the
    // reopen, so `>= reopenedAt` (a timestamp between the two closes) distinguishes fixed from stale.
    expect(reopened.reopenedAt).not.toBeNull();
    expect(reclosed.closedAt.getTime()).toBeGreaterThanOrEqual(reopened.reopenedAt!.getTime());
    expect(reclosed.closedAt.getTime()).toBeGreaterThan(first.closedAt.getTime());
  });
});

// -------------------------------------------------------------------------------------------
// Concurrency (spec §12). Two serializers are load-bearing: the month advisory lock (period-locks.ts,
// Task 4) ORDERS a posting and a close, and Serializable isolation on BOTH sides lets SSI backstop
// the posting-vs-close phantom. Test 1 is the DANGEROUS direction — the real Serializable
// `finalizeInvoice` whose snapshot predates a committed close — proving the SSI backstop (RED-verified
// by reverting `closePeriod` to Read Committed: the finalize leaks in FINALIZED). Test 2 is two
// concurrent closes, proving `retryOnSerializationConflict` absorbs the loser's conflict (RED-verified
// by disabling the retry: the loser surfaces the unique/serialization conflict). Transcripts in
// task-5-report.md.
// -------------------------------------------------------------------------------------------

describe("concurrency — Serializable + the month advisory lock protect a posting and a close (spec §12)", () => {
  it("DANGEROUS direction: a real Serializable finalize whose snapshot predates a committed close is refused/aborted — no FINALIZED invoice leaks into the closed month", async () => {
    // The finding this test proves: `finalizeInvoice` runs Serializable and FIXES its snapshot at
    // `claimInvoiceRow` — BEFORE `assertPeriodOpen`'s `lockMonth`/period read. If a close commits its
    // CLOSED row after that snapshot, the finalize's period `findFirst` misses it (no `FOR UPDATE`)
    // and would post FINALIZED into a just-closed month. Only SSI catches it, and only if the close is
    // ALSO Serializable.
    //
    // Ruling 8: finalize recognizes the invoice in its FINALIZE month, so it guards TODAY's month —
    // the SSI edge (finalize's `assertPeriodOpen` predicate read ↔ close's CLOSED-row insert) forms
    // only when the close closes TODAY's month. So this test closes the CURRENT month; the draft's
    // own document date is irrelevant to the guard.
    //
    // Determinism: a GATE (Read Committed) holds the ORDER row `FOR UPDATE`, so the REAL finalize fixes
    // its snapshot at its first read and then BLOCKS at `claimOrder`'s `SELECT ... FOR UPDATE` —
    // pausing it AFTER its snapshot is fixed and BEFORE its period read. We then run the REAL
    // `closePeriod(currentYear, currentMonth)` to completion (it commits a CLOSED current month,
    // endingAr 0 — the invoice is still DRAFT), release the gate, and let the finalize proceed on its
    // now-stale snapshot. Both sides Serializable → SSI aborts the finalize (40001 → 409) or it is
    // refused period-closed (409).
    //
    // RED-verified by reverting `closePeriod` to Read Committed (drop its `isolationLevel`): the close
    // is invisible to SSI, the finalize's stale read misses the CLOSED row, nothing aborts it, and it
    // commits FINALIZED into the closed month — `outcome` becomes "resolved" and the invoice FINALIZED.
    const today = todayDateOnly();
    const cy = today.getUTCFullYear();
    const cm = today.getUTCMonth() + 1;
    const { invoiceId, orderId } = await makeDraftInvoiceDated("2026-07-15", 100); // document date irrelevant

    let gateReady!: () => void;
    const gated = new Promise<void>((r) => { gateReady = r; });
    let releaseGate!: () => void;
    const gateRelease = new Promise<void>((r) => { releaseGate = r; });

    // GATE: Read Committed on purpose — it must hold the order row WITHOUT forming an SSI edge with
    // the finalize, so the ONLY dangerous structure is finalize(read month open) ↔ close(insert CLOSED).
    const gate = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      gateReady();
      await gateRelease;
    }, { timeout: 20000 });
    await gated;

    // Start the REAL finalize; it fixes its Serializable snapshot at its first read, then blocks on
    // the gated order row (well before its period read).
    const finalizeProm = asSystem(() => finalizeInvoice(invoiceId)).then(
      () => "resolved" as const,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 200)); // let the finalize fix its snapshot + block on the order

    // Close the CURRENT month NOW — commits its CLOSED row while the finalize is paused with an older
    // snapshot. It is a genesis close (nothing earlier closed) and the invoice is still DRAFT → $0.
    const closed = await asSystem(() => closePeriod(cy, cm));
    expect(closed.status).toBe("CLOSED");
    expect(closed.endingAr).toBe(0); // the invoice is still DRAFT, so the frozen schedule is $0

    releaseGate();
    await gate;

    const outcome = await finalizeProm;
    expect(outcome).not.toBe("resolved"); // it must NOT have finalized into the closed month
    expect(outcome).toBeInstanceOf(HttpError);
    expect((outcome as HttpError).status).toBe(409); // period-closed OR serialization-abort — both 409

    // PROOF: no FINALIZED invoice leaked, and the frozen close schedule still reads $0.
    const inv = await prisma.invoice.findFirst({ where: { id: invoiceId } });
    expect(inv?.status).toBe("DRAFT");
    const row = await prisma.closePeriod.findFirst({ where: { year: cy, month: cm } });
    expect(row?.status).toBe("CLOSED");
    expect(row?.endingAr.toNumber()).toBe(0);
  });

  it("two concurrent closes of one month: exactly one CLOSED row, NEITHER errors (the retry absorbs the loser)", async () => {
    // HOLDER (Read Committed): hand-scripts the WINNING close's critical section — the SAME month
    // advisory lock `closePeriod` takes — inserts the CLOSED July row, and holds it uncommitted.
    // COMPETITOR: the real `closePeriod(2026, 7)` (Serializable + retry). It BLOCKS on the held month;
    // when the holder commits, it unblocks with a snapshot fixed BEFORE that commit (the blocking
    // `lockMonth` SELECT took the snapshot before the lock was granted), so its `findFirst` misses the
    // row and its INSERT collides on @@unique([year, month]) — and `retryOnSerializationConflict`
    // re-runs it: the fresh snapshot sees the row and UPDATES it. One CLOSED row, no error.
    //
    // RED-verified by disabling the retry (call `prisma.$transaction` directly, no wrapper — or
    // tries=1): the collision escapes as P2002 → HttpError(400) and `await competitor` REJECTS, so
    // `result.status` throws.
    let hasClaimed!: () => void;
    const claimed = new Promise<void>((r) => { hasClaimed = r; });
    let mayRelease!: () => void;
    const release = new Promise<void>((r) => { mayRelease = r; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4200, 202607)`;
      await tx.closePeriod.create({
        data: {
          year: 2026, month: 7, status: "CLOSED", beginningAr: 0, invoicedTotal: 0, creditTotal: 0,
          paymentTotal: 0, discountTotal: 0, writeOffTotal: 0, endingAr: 0, agingEndingAr: 0,
        },
      });
      hasClaimed();
      await release;
    }, { timeout: 20000 });

    await claimed;

    const competitor = asSystem(() => closePeriod(2026, 7));
    await new Promise((r) => setTimeout(r, 150)); // let it block on the held month
    mayRelease();
    await holder;

    const result = await competitor; // GREEN: retry updates the holder's row. RED: rejects on the unique index
    expect(result.status).toBe("CLOSED");
    expect(await prisma.closePeriod.count({ where: { year: 2026, month: 7 } })).toBe(1);
  });
});
