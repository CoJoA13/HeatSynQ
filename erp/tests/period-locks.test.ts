import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { finalizeInvoice } from "@/server/invoices";
import { createBatch, addPayment, postBatch } from "@/server/receipts";
import { parseDateOnly } from "@/lib/business-days";
import { assertPeriodOpen, closedPeriodFor, lockMonth } from "@/server/period-locks";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(truncateAll);

async function closeMonth(year: number, month: number) {
  return prisma.closePeriod.create({
    data: { year, month, beginningAr: 0, invoicedTotal: 0, creditTotal: 0, paymentTotal: 0,
      discountTotal: 0, writeOffTotal: 0, endingAr: 0, agingEndingAr: 0 },
  });
}

// ---------------------------------------------------------------------------------------------
// Step 1: the guard itself.
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// Step 4: the leaf really is a leaf — the invoice-guards.ts import-shape pin, applied here.
// ---------------------------------------------------------------------------------------------

it("stays a dependency-free leaf", () => {
  const src = readFileSync(new URL("../src/server/period-locks.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/from ["']\.\/(invoices|receipts|applications|orders|shippers|close-periods|gl-export)["']/);
  expect(src).not.toMatch(/\brequire\(|import\(/);
});

// ---------------------------------------------------------------------------------------------
// Step 7a: the guard is WIRED into the real finalize path. RED-verified by deleting the
// `assertPeriodOpen(tx, invoice.invoiceDate)` call in `finalizeInvoiceInTx` — the invoice then
// finalizes clean and this test fails to throw (transcript in task-4-report.md). The invoice is
// built raw (the applications-concurrency.test.ts pattern): a zero-line DRAFT reaches the guard
// through finalize's only pre-guard block (`needsPrice`), and with no lines and no customer terms it
// also finalizes cleanly once the guard is removed, so the RED run resolves rather than throwing
// some unrelated error.
// ---------------------------------------------------------------------------------------------

let seq = 0;
async function draftInvoiceDated(dateStr: string): Promise<string> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `PC${seq}`, name: `Period Customer ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 720000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-07-01"), requestDate: parseDateOnly("2026-07-01"),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "DRAFT", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly(dateStr),
    },
  });
  return invoice.id;
}

it("refuses finalizing an invoice dated in a closed month", async () => {
  const invoiceId = await draftInvoiceDated("2026-07-10");
  await closeMonth(2026, 7);
  await expect(asSystem(() => finalizeInvoice(invoiceId))).rejects.toThrow(/closed/i);
  // Refused, not half-applied: the invoice is still a DRAFT.
  expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("DRAFT");
});

it("finalizes normally when the invoice's month is open (the guard is a no-op)", async () => {
  const invoiceId = await draftInvoiceDated("2026-08-10"); // August, never closed here
  await closeMonth(2026, 7);                                // a DIFFERENT month is closed
  const done = await asSystem(() => finalizeInvoice(invoiceId));
  expect(done.status).toBe("FINALIZED");
});

// ---------------------------------------------------------------------------------------------
// Step 7b: prove the load-bearing mechanism — `lockMonth` takes a REAL transaction-level advisory
// lock that serializes two transactions on the same month, which no plain `findFirst` could. This is
// the phantom-closing lock the guard and Task 5's close both rely on (the finalize-vs-close race
// itself is Task 5's to integration-test, since `closePeriod` does not exist yet). RED-verified by
// stubbing `lockMonth`'s body to a no-op: B then never blocks and `bLockedWhileAHeld` reads true
// (transcript in task-4-report.md).
// ---------------------------------------------------------------------------------------------

describe("lockMonth advisory lock", () => {
  it("serializes two transactions on the SAME month; a DIFFERENT month does not block", async () => {
    // A takes month 7 and holds it open until we release it.
    let aHasLock!: () => void;
    const aLocked = new Promise<void>((r) => { aHasLock = r; });
    let releaseA!: () => void;
    const aMayRelease = new Promise<void>((r) => { releaseA = r; });

    const txA = prisma.$transaction(async (tx) => {
      await lockMonth(tx, 2026, 7);
      aHasLock();            // A definitely holds month 7 now
      await aMayRelease;     // hold the lock open
    }, { timeout: 15000 });

    await aLocked;

    // A DIFFERENT month is not blocked by A's lock — completes while A still holds month 7.
    let otherMonthDone = false;
    await prisma.$transaction(async (tx) => { await lockMonth(tx, 2026, 8); otherMonthDone = true; });
    expect(otherMonthDone).toBe(true);

    // The SAME month blocks: B cannot take month 7 until A commits.
    let bDone = false;
    const txB = prisma.$transaction(async (tx) => { await lockMonth(tx, 2026, 7); bDone = true; },
      { timeout: 15000 });

    // Give B a window to (wrongly) proceed if the lock were a no-op; it must stay blocked.
    await new Promise((r) => setTimeout(r, 200));
    const bLockedWhileAHeld = bDone;

    releaseA();            // A commits, dropping the xact lock
    await txA;
    await txB;             // B now unblocks and finishes

    expect(bLockedWhileAHeld).toBe(false); // B was blocked the whole time A held month 7
    expect(bDone).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 1 (review finding, ABBA deadlock): `postBatch` must guard EVERY distinct month a
// multi-month batch's payments fall in, not just the first one found — the fix sorts/dedups to
// one advisory-lock call per distinct (year, month), ascending, closing the deadlock window an
// unsorted per-payment loop would open between two batches sharing two months. The ordering
// itself is a concurrency invariant, not something a single-process test can observe; what IS
// testable here is coverage — a closed month anywhere in the batch refuses the whole post, and
// with none closed the post goes through covering every month.
// ---------------------------------------------------------------------------------------------

describe("postBatch — guards every distinct month of a multi-month batch", () => {
  let seq = 0;
  async function batchSpanningTwoMonths(): Promise<string> {
    seq += 1;
    const customer = await prisma.customer.create({
      data: { code: `PLB${seq}`, name: `Period Batch Customer ${seq}` } });
    const paymentType = await prisma.paymentType.create({ data: { name: `Check ${seq}` } });
    const batch = await asSystem(() => createBatch({ depositDate: "2026-07-15", controlTotal: null }));
    await asSystem(() => addPayment(batch.id, {
      customerId: customer.id, paymentTypeId: paymentType.id, amount: 100,
      reference: "a", receivedDate: "2026-06-15",
    }));
    await asSystem(() => addPayment(batch.id, {
      customerId: customer.id, paymentTypeId: paymentType.id, amount: 200,
      reference: "b", receivedDate: "2026-07-15",
    }));
    return batch.id;
  }

  it("refuses postBatch when only the SECOND month of the batch is closed", async () => {
    const batchId = await batchSpanningTwoMonths();
    await closeMonth(2026, 7); // June (the first payment's month) stays open
    await expect(asSystem(() => postBatch(batchId))).rejects.toMatchObject({
      status: 409, message: expect.stringMatching(/2026-07 is closed/),
    });
  });

  it("posts cleanly when neither month is closed", async () => {
    const batchId = await batchSpanningTwoMonths();
    const posted = await asSystem(() => postBatch(batchId));
    expect(posted.status).toBe("POSTED");
  });
});
