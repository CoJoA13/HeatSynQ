import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { closePeriod, preliminaryReport, reopenPeriod } from "@/server/close-periods";
import { parseDateOnly } from "@/lib/business-days";

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

async function makeFinalizedInvoiceDated(dateStr: string, total: number): Promise<InvoiceRef> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `CLP${seq}`, name: `Close Customer ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 750000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly(dateStr), requestDate: parseDateOnly(dateStr),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly(dateStr), dueDate: parseDateOnly(dateStr),
      total, finalizedAt: parseDateOnly(dateStr),
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
});

// -------------------------------------------------------------------------------------------
// Concurrency (spec §12). The load-bearing serializer is the month advisory lock (period-locks.ts,
// Task 4), NOT the isolation level — closePeriod runs at Read Committed on purpose (see the service
// header). Both tests follow the 5B two-interleaved-transactions technique: the competing side runs
// at Read Committed so SSI is OFF THE TABLE and the ONLY thing that can serialize the two is the
// advisory lock. Each is RED-verified by removing `lockMonth` from `closePeriod` (transcripts in
// task-5-report.md).
// -------------------------------------------------------------------------------------------

describe("concurrency — the month advisory lock serializes a posting and a close (spec §12)", () => {
  it("a finalize racing a close serializes: the close counts the invoice, never a closed month with an uncounted one", async () => {
    // HOLDER (Read Committed / DEFAULT): hand-scripts the finalize's critical section — the SAME
    // month advisory lock `finalizeInvoice` takes via `assertPeriodOpen` — then writes the finalized
    // July invoice and holds it uncommitted. COMPETITOR: the real `closePeriod(2026, 7)`. The
    // apply/void postings §12 also names share the identical assertPeriodOpen→lockMonth guard, so
    // this one finalize proof covers them.
    //
    // RED-verified by removing `lockMonth` from `closePeriod`: the close then does NOT block on the
    // held month — it reads past the uncommitted invoice (endingAr 0), commits a CLOSED July, and the
    // invoice lands in that closed month uncounted; the `raceResult === TIMED_OUT` assertion flips to
    // "settled".
    seq += 1;
    const customer = await prisma.customer.create({ data: { code: `CXN${seq}`, name: `CXN ${seq}` } });
    const order = await prisma.order.create({
      data: {
        orderNumber: 760000 + seq, customerId: customer.id, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-07-01"), requestDate: parseDateOnly("2026-07-01"),
      },
    });

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((r) => { hasClaimed = r; });
    let mayRelease!: () => void;
    const release = new Promise<void>((r) => { mayRelease = r; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4200, 202607)`;
      await tx.invoice.create({
        data: {
          kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
          invoiceDate: parseDateOnly("2026-07-15"), dueDate: parseDateOnly("2026-07-15"),
          total: 100, finalizedAt: parseDateOnly("2026-07-15"),
        },
      });
      hasClaimed();
      await release;
    }, { timeout: 20000 });

    await claimed;

    const closeProm = asSystem(() => closePeriod(2026, 7));
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      closeProm.then(() => "settled" as const, () => "settled" as const),
      new Promise((r) => setTimeout(() => r(TIMED_OUT), 250)),
    ]);

    mayRelease();
    await holder;

    expect(raceResult).toBe(TIMED_OUT); // the close was blocked on the month the finalize held

    const closed = await closeProm; // unblocks, reads the now-committed invoice on a fresh snapshot
    expect(closed.status).toBe("CLOSED");
    expect(closed.endingAr).toBe(100); // the finalize landed first and IS counted
    expect(await prisma.closePeriod.count({ where: { year: 2026, month: 7, status: "CLOSED" } })).toBe(1);
  });

  it("a second close of one month serializes behind the first: exactly one CLOSED row, neither errors", async () => {
    // HOLDER (Read Committed): hand-scripts the first close's critical section — the SAME month
    // advisory lock `closePeriod` takes — inserts the CLOSED July row, and holds it uncommitted.
    // COMPETITOR: the real `closePeriod(2026, 7)`. With `lockMonth`, the competitor BLOCKS on the
    // held month, then on a FRESH post-lock read sees the (now-committed) row and UPDATES it —
    // exactly one CLOSED row, no error. This forces the collision window a bare `Promise.all` leaves
    // to timing.
    //
    // RED-verified by removing `lockMonth` from `closePeriod`: the competitor does NOT block on the
    // month, its `findFirst` misses the holder's uncommitted row, and its INSERT collides on the
    // @@unique([year, month]) index — `await competitor` then REJECTS instead of resolving CLOSED.
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
    await new Promise((r) => setTimeout(r, 150)); // let it reach lockMonth (GREEN) / its insert (RED)
    mayRelease();
    await holder;

    const result = await competitor; // GREEN: updates the holder's row. RED: rejects on the unique index
    expect(result.status).toBe("CLOSED");
    expect(await prisma.closePeriod.count({ where: { year: 2026, month: 7 } })).toBe(1);
  });
});
