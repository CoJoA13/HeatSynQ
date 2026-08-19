import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { writeOffInvoice, voidApplication, openItemsForCustomer } from "@/server/applications";
import { customerReceivablesSummary } from "@/server/customer-receivables";
import { unlockInvoice } from "@/server/invoices";
import { voidOrder } from "@/server/orders";
import { closePeriod, preliminaryReport } from "@/server/close-periods";
import { exportClose } from "@/server/gl-export";
import { agingReport } from "@/server/aging";
import { buildStatement } from "@/server/statements";
import { invoiceOpenBalance, type ApplicationLite } from "@/server/ar-balances";
import { HttpError } from "@/server/errors";
import { formatDateOnly, parseDateOnly, todayDateOnly } from "@/lib/business-days";

// -------------------------------------------------------------------------------------------
// #77 — the STANDALONE bad-debt write-off. Spec §3 ruling 1 calls for write-offs in both flavors —
// a small residual and a wholly uncollectable invoice — but until now the only path was
// `applyPayment`, which requires a `paymentId`: an operator could only write off a residual from an
// existing receipt panel, and a wholly uncollectable invoice had no path short of fabricating a
// receipt. The schema and the tightened `Application_source_check` already permitted a WRITE_OFF
// with a null `paymentId`; nothing wrote one.
//
// `writeOffInvoice` is modelled on `applyCredit` (the closest sibling: one target invoice, no
// payment row) and claims like `voidApplicationInTx` (the SINGLE-invoice shape). Its date is
// ALWAYS `todayDateOnly()`, never operator-chosen: a backdate into an open PRIOR month would
// silently move that month's aging buckets and roll-forward, and `assertPeriodOpen` would happily
// permit it.
//
// The GL question is already answered — 5C ruling 3 pinned ONE write-off account
// (`BillingConfig.writeOffGlAccountId`) and explicitly ruled the residual-vs-bad-debt split out — so
// a standalone write-off posts DR write-off / CR A/R identically to a residual one. GL, close,
// aging and statements are all `paymentId`-blind and need no change; the "reads it, unchanged"
// describes below VERIFY that rather than assuming it.
// -------------------------------------------------------------------------------------------

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(truncateAll);

// Every fixture is dated TODAY, because the write-off's `appliedDate` is today by construction:
// an invoice dated in some earlier month would sit outside the point-in-time cuts the aging strip,
// the roll-forward and the statement all apply, and the tests would measure the fixture's dates
// rather than the write-off.
const TODAY = formatDateOnly(todayDateOnly());
const TODAY_DATE = todayDateOnly();
const CURRENT_YEAR = TODAY_DATE.getUTCFullYear();
const CURRENT_MONTH = TODAY_DATE.getUTCMonth() + 1;

let seq = 0;

type Fixture = { invoiceId: string; orderId: string; orderNumber: number; customerId: string };

async function invoiceFixture(opts: {
  total: number;
  kind?: "INVOICE" | "CREDIT";
  status?: "DRAFT" | "FINALIZED";
  customerId?: string;
  glAccountId?: string;
  stepCodeId?: string;
}): Promise<Fixture> {
  seq += 1;
  const customerId = opts.customerId ?? (await prisma.customer.create({
    data: { code: `WOC${seq}`, name: `Write-off Customer ${seq}` },
  })).id;
  const orderNumber = 520000 + seq;
  const order = await prisma.order.create({
    data: {
      orderNumber, customerId, status: "SHIPPED",
      receivedDate: parseDateOnly(TODAY), requestDate: parseDateOnly(TODAY),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: opts.kind ?? "INVOICE", status: opts.status ?? "FINALIZED",
      orderId: order.id, customerId,
      invoiceDate: parseDateOnly(TODAY), dueDate: parseDateOnly(TODAY),
      total: opts.total, subtotal: opts.total,
      finalizedAt: opts.status === "DRAFT" ? null : parseDateOnly(TODAY),
      ...(opts.glAccountId
        ? {
            lines: {
              create: [{
                position: 1, kind: "OPERATION" as const, processStepCodeId: opts.stepCodeId,
                glAccountId: opts.glAccountId, glAccountName: "4010-REV",
                description: "Heat treat", amount: opts.total,
              }],
            },
          }
        : {}),
    },
  });
  return { invoiceId: invoice.id, orderId: order.id, orderNumber, customerId };
}

/** A real receipt + PAYMENT application — the only way to reduce an invoice with CASH, and the
 *  shape a RESIDUAL (payment-sourced) write-off rides alongside. */
async function payInvoice(inv: Fixture, amount: number): Promise<string> {
  seq += 1;
  const batch = await prisma.receiptBatch.create({
    data: { batchNumber: 920000 + seq, depositDate: parseDateOnly(TODAY) },
  });
  const paymentType = await prisma.paymentType.create({ data: { name: `WOPT-${seq}` } });
  const payment = await prisma.payment.create({
    data: {
      batchId: batch.id, customerId: inv.customerId, paymentTypeId: paymentType.id,
      amount, receivedDate: parseDateOnly(TODAY),
    },
  });
  await prisma.application.create({
    data: { invoiceId: inv.invoiceId, amount, type: "PAYMENT", paymentId: payment.id, appliedDate: parseDateOnly(TODAY) },
  });
  return payment.id;
}

const toLite = (a: { amount: { toNumber(): number }; type: ApplicationLite["type"]; deletedAt: Date | null }): ApplicationLite =>
  ({ amount: a.amount.toNumber(), type: a.type, deletedAt: a.deletedAt });

async function openBalance(invoiceId: string): Promise<number> {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { applications: true } });
  return invoiceOpenBalance(inv.total.toNumber(), inv.applications.map(toLite));
}

// -------------------------------------------------------------------------------------------
// The service.
// -------------------------------------------------------------------------------------------

describe("writeOffInvoice — the standalone bad-debt write-off (#77)", () => {
  it("writes a WRITE_OFF with NO payment, dated today, reason trimmed, closing the invoice", async () => {
    const inv = await invoiceFixture({ total: 1000 });

    await asSystem(() => writeOffInvoice({
      invoiceId: inv.invoiceId, amount: 1000, reason: "  customer in liquidation — uncollectable  ",
    }));

    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });
    expect(app.type).toBe("WRITE_OFF");
    // THE fact that distinguishes this row from every other application: no payment behind it.
    expect(app.paymentId).toBeNull();
    expect(app.creditInvoiceId).toBeNull();
    expect(formatDateOnly(app.appliedDate)).toBe(TODAY);
    expect(app.reason).toBe("customer in liquidation — uncollectable");
    expect(app.amount.toNumber()).toBe(1000);
    expect(await openBalance(inv.invoiceId)).toBe(0);

    const entry = await prisma.auditLog.findFirst({
      where: { entity: "application", entityId: app.id, action: "create" },
    });
    expect(entry).not.toBeNull();
    const after = entry!.after as Record<string, unknown>;
    expect(after.type).toBe("WRITE_OFF");
    expect(after.paymentId).toBeNull();
    expect(after.amount).toBe(1000);
    expect(after.reason).toBe("customer in liquidation — uncollectable");
    expect(after.appliedDate).toBe(TODAY);
    expect(after.invoiceOrderNumber).toBe(inv.orderNumber);
  });

  it("writes off part of a balance, leaving the remainder open and writeable-off again", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 400, reason: "disputed surcharge" }));
    expect(await openBalance(inv.invoiceId)).toBe(600);
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 600, reason: "the rest, uncollectable" }));
    expect(await openBalance(inv.invoiceId)).toBe(0);
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId, deletedAt: null } })).toBe(2);
  });

  it("writes off the residual left by a partial payment", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await payInvoice(inv, 995);
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 5, reason: "short pay, not worth chasing" }));
    expect(await openBalance(inv.invoiceId)).toBe(0);
  });

  // The wording is shared with the residual flavor deliberately — the two must read identically,
  // and `tests/applications.test.ts` already pins this exact string for `applyPayment`'s line.
  it("refuses a write-off with NO reason, with the same wording the residual flavor uses", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await expect(asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 100 })))
      .rejects.toMatchObject({ status: 400, message: "a write-off needs a reason" });
    expect(await prisma.application.count()).toBe(0);
  });

  it("refuses a whitespace-only reason", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await expect(asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 100, reason: "   \t  " })))
      .rejects.toMatchObject({ status: 400, message: "a write-off needs a reason" });
    expect(await prisma.application.count()).toBe(0);
  });

  it("refuses an amount greater than the live open balance, naming it", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await payInvoice(inv, 600);
    await expect(asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 401, reason: "too much" })))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/exceeds the invoice's open balance of 400/) });
    expect(await openBalance(inv.invoiceId)).toBe(400);
  });

  it("refuses a write-off against an already-settled invoice", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await payInvoice(inv, 1000);
    await expect(asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 10, reason: "nothing left" })))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/exceeds the invoice's open balance of 0/) });
  });

  it("refuses a DRAFT invoice — only finalized paper carries a receivable", async () => {
    const inv = await invoiceFixture({ total: 1000, status: "DRAFT" });
    await expect(asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 100, reason: "premature" })))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not finalized/) });
    expect(await prisma.application.count()).toBe(0);
  });

  it("refuses a CREDIT memo — a write-off applies to an invoice", async () => {
    const credit = await invoiceFixture({ total: -500, kind: "CREDIT" });
    await expect(asSystem(() => writeOffInvoice({ invoiceId: credit.invoiceId, amount: 100, reason: "wrong document" })))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/credit, not an invoice/) });
    expect(await prisma.application.count()).toBe(0);
  });

  it("404s a discarded (soft-deleted) invoice", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await prisma.invoice.update({ where: { id: inv.invoiceId }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 100, reason: "discarded" })))
      .rejects.toMatchObject({ status: 404 });
    expect(await prisma.application.count()).toBe(0);
  });

  it("404s an invoice that does not exist", async () => {
    await expect(asSystem(() => writeOffInvoice({ invoiceId: "no-such-invoice", amount: 100, reason: "typo" })))
      .rejects.toMatchObject({ status: 404 });
  });

  it("refuses a zero or negative amount at the schema boundary", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await expect(asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 0, reason: "nothing" })))
      .rejects.toThrow(/greater than zero/i);
    await expect(asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: -50, reason: "negative" })))
      .rejects.toThrow(/greater than zero/i);
    expect(await prisma.application.count()).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// The undo. `voidApplication` already worked on a null-payment row — but nothing in the UI could
// REACH one, because `BatchDetail` lists applications per PAYMENT. This is the only correction
// path a standalone write-off has, so it is pinned here rather than left implied.
// -------------------------------------------------------------------------------------------

describe("voidApplication on a standalone write-off — the only route back", () => {
  it("restores the full open balance and records the reason", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "wrote off the wrong invoice" }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });
    expect(await openBalance(inv.invoiceId)).toBe(0);

    await asSystem(() => voidApplication(app.id, "  mis-keyed — wrong customer  "));

    expect(await openBalance(inv.invoiceId)).toBe(1000);
    const voided = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(voided.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "application", entityId: app.id, action: "delete" },
    });
    expect(entry).not.toBeNull();
    expect(entry!.reason).toBe("mis-keyed — wrong customer");
  });

  it("returns the invoice to the open-items table as an ordinary open item", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });
    await asSystem(() => voidApplication(app.id, "reinstated"));

    const items = await openItemsForCustomer(inv.customerId);
    const row = items.find((i) => i.id === inv.invoiceId)!;
    expect(row.open).toBe(1000);
    expect(row.writeOffs).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// The §5.14 interaction with `hasReceivableActivity` (review round 1). That guard matches ANY live
// `Application` by invoice, with no type or `paymentId` predicate — so a standalone write-off blocks
// unlock, discard and void-order, which is correct: paper with money written off it must not become
// editable underneath the write-off. What was NOT correct was the wording. Before #77 a WRITE_OFF
// always carried a payment, so "void the payments" was always a true instruction; a null-payment
// write-off makes those refusals reachable and false, sending the operator to the receipt batches
// after a row that does not exist. The messages now name write-offs and the screen that voids them.
// -------------------------------------------------------------------------------------------

const NAMES_THE_ROUTE_OUT =
  /has payments, credits or write-offs applied — void them before unlocking \(a bad-debt write-off is voided from the customer's Receivables section\)/;

describe("a standalone write-off blocks unlock and void-order, naming the way back", () => {
  it("refuses to unlock the invoice, naming write-offs AND where they are voided from", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));

    await expect(asSystem(() => unlockInvoice(inv.invoiceId, "correct a line")))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(NAMES_THE_ROUTE_OUT) });
    // Refused, not half-applied.
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.invoiceId } })).status).toBe("FINALIZED");
  });

  // The other half of §5.14: the route the refusal names has to actually work. A message that sends
  // the operator somewhere useless is the defect; a message that sends them somewhere that unblocks
  // them is the fix, and this is what proves the difference.
  it("permits the unlock once that write-off is voided from the Receivables section", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });

    await asSystem(() => voidApplication(app.id, "mis-keyed"));

    await asSystem(() => unlockInvoice(inv.invoiceId, "correct a line"));
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.invoiceId } })).status).toBe("DRAFT");
  });

  it("refuses to void the order, naming write-offs there too", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));

    await expect(asSystem(() => voidOrder(inv.orderId, "entered against the wrong customer")))
      .rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(
          /void the payments, credits or write-offs applied to it first \(a bad-debt write-off is voided from the customer's Receivables section\)/),
      });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: inv.orderId } })).deletedAt).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// The A/R surface. `openItemsForCustomer` drops anything settled (`open <= 0`), so a wholly
// written-off invoice VANISHED from the only table that could anchor the undo — the mis-keyed
// bad-debt write-off was uncorrectable outside SQL. Owner ruling 2026-08-19: the write-off must be
// undoable from the screen that made it (§5.14, "a block must name a route out of itself").
// -------------------------------------------------------------------------------------------

describe("openItemsForCustomer — a written-off invoice stays reachable", () => {
  it("keeps a fully written-off invoice, at zero, carrying the void handle", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });

    const items = await openItemsForCustomer(inv.customerId);
    const row = items.find((i) => i.id === inv.invoiceId);
    expect(row).toBeDefined();
    expect(row!.kind).toBe("INVOICE");
    expect(row!.open).toBe(0);
    expect(row!.writeOffs).toHaveLength(1);
    expect(row!.writeOffs[0]).toMatchObject({
      id: app.id, amount: 1000, appliedDate: TODAY, reason: "uncollectable",
    });
  });

  it("keeps the retained row at ZERO, so the open items still sum to the net above them (#83)", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    const other = await invoiceFixture({ total: 250, customerId: inv.customerId });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));

    const { aging, openItems } = await asSystem(() => customerReceivablesSummary(inv.customerId));
    expect(aging.net).toBe(250); // only the other invoice is still owed
    const summed = openItems.reduce((total, i) => total + Math.round(i.open * 100), 0);
    expect(summed).toBe(Math.round(aging.net * 100));
    expect(openItems.map((i) => i.id)).toContain(inv.invoiceId);
    expect(openItems.map((i) => i.id)).toContain(other.invoiceId);
  });

  it("shows the void handle on a PARTIALLY written-off invoice too, alongside its live balance", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 400, reason: "disputed surcharge" }));

    const items = await openItemsForCustomer(inv.customerId);
    const row = items.find((i) => i.id === inv.invoiceId)!;
    expect(row.open).toBe(600);
    expect(row.writeOffs).toHaveLength(1);
    expect(row.writeOffs[0].amount).toBe(400);
  });

  // The complement, and the reason this surface is scoped to null-payment rows: a RESIDUAL
  // write-off is already reachable from its receipt batch (`BatchDetail`'s per-payment application
  // list). Retaining those here too would park every invoice ever settled with a residual in a
  // table headed "Open items", forever, duplicating a control that already exists.
  it("does NOT retain an invoice settled by cash plus a payment-sourced residual write-off", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    const paymentId = await payInvoice(inv, 995);
    await prisma.application.create({
      data: {
        invoiceId: inv.invoiceId, amount: 5, type: "WRITE_OFF", reason: "short pay",
        paymentId, appliedDate: parseDateOnly(TODAY),
      },
    });
    const items = await openItemsForCustomer(inv.customerId);
    expect(items.map((i) => i.id)).not.toContain(inv.invoiceId);
  });

  it("drops the retained row again once the write-off is voided and re-settled by cash", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });
    await asSystem(() => voidApplication(app.id, "they paid after all"));
    await payInvoice(inv, 1000);

    const items = await openItemsForCustomer(inv.customerId);
    expect(items.map((i) => i.id)).not.toContain(inv.invoiceId);
  });
});

// -------------------------------------------------------------------------------------------
// The period lock. A write-off is cash-journal paper effective at `appliedDate` (today), so it is
// refused into a CLOSED month exactly as every other posting mutation is.
// -------------------------------------------------------------------------------------------

describe("the period lock", () => {
  it("refuses a write-off into a CLOSED month (409)", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => closePeriod(CURRENT_YEAR, CURRENT_MONTH));
    await expect(asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 100, reason: "too late" })))
      .rejects.toMatchObject({ status: 409 });
    expect(await prisma.application.count()).toBe(0);
  });

  it("lands in the open month's roll-forward as writeOffTotal, still reconciling (variance 0)", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 250, reason: "settlement discount agreed" }));

    const prelim = await preliminaryReport(CURRENT_YEAR, CURRENT_MONTH);
    expect(prelim.schedule.invoicedTotal).toBe(1000);
    expect(prelim.schedule.writeOffTotal).toBe(250);
    expect(prelim.schedule.endingAr).toBe(750);
    expect(prelim.schedule.variance).toBe(0); // the roll-forward and the aging agree

    const closed = await asSystem(() => closePeriod(CURRENT_YEAR, CURRENT_MONTH));
    expect(closed.writeOffTotal).toBe(250);
    expect(closed.endingAr).toBe(750);
  });
});

// -------------------------------------------------------------------------------------------
// GL, aging and statements: all three read the Application rows without ever looking at
// `paymentId`, so a standalone write-off needs no change in any of them. VERIFIED, not assumed.
// -------------------------------------------------------------------------------------------

describe("GL export — a standalone write-off posts DR write-off / CR A/R (5C ruling 3)", () => {
  it("posts the same journal a payment-sourced write-off does, from the one write-off account", async () => {
    const ar = await prisma.glAccount.create({ data: { name: "1200-AR" } });
    const rev = await prisma.glAccount.create({ data: { name: "4010-REV" } });
    const writeOffAccount = await prisma.glAccount.create({ data: { name: "6000-WO" } });
    const discount = await prisma.glAccount.create({ data: { name: "4900-DISC" } });
    const tax = await prisma.glAccount.create({ data: { name: "2200-TAX" } });
    const step = await prisma.processStepCode.create({ data: { code: "HT", name: "Heat Treat", glAccountId: rev.id } });
    await prisma.billingConfig.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton", arGlAccountId: ar.id, discountGlAccountId: discount.id,
        writeOffGlAccountId: writeOffAccount.id, salesTaxGlAccountId: tax.id,
      },
      update: {
        arGlAccountId: ar.id, discountGlAccountId: discount.id,
        writeOffGlAccountId: writeOffAccount.id, salesTaxGlAccountId: tax.id,
      },
    });

    const inv = await invoiceFixture({ total: 1000, glAccountId: rev.id, stepCodeId: step.id });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });

    const period = await asSystem(() => closePeriod(CURRENT_YEAR, CURRENT_MONTH));
    await asSystem(() => exportClose(period.id));

    const postings = await prisma.glPosting.findMany({
      where: { sourceType: "WRITE_OFF", sourceId: app.id },
      select: { glAccountId: true, debit: true, credit: true, side: true },
    });
    expect(postings).toHaveLength(2);
    const debitRow = postings.find((p) => p.debit.toNumber() !== 0)!;
    const creditRow = postings.find((p) => p.credit.toNumber() !== 0)!;
    expect(debitRow.glAccountId).toBe(writeOffAccount.id); // DR the ONE write-off account
    expect(debitRow.debit.toNumber()).toBe(1000);
    expect(creditRow.glAccountId).toBe(ar.id); // CR A/R
    expect(creditRow.credit.toNumber()).toBe(1000);
  });
});

describe("aging and statements read a null-payment write-off unchanged", () => {
  it("aging: the written-off balance leaves the customer's buckets and net", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    const before = await agingReport({ customerId: inv.customerId, asOf: TODAY });
    expect(before[0].net).toBe(1000);

    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 600, reason: "partly uncollectable" }));

    const after = await agingReport({ customerId: inv.customerId, asOf: TODAY });
    expect(after[0].net).toBe(400);
  });

  it("statement: the written-off invoice drops out of the open items and off the total due", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));

    const data = await buildStatement(inv.customerId, { asOf: TODAY, combineFamily: false, assessFinanceCharges: false });
    expect(data.openItems).toHaveLength(0); // the invoice was this customer's only open item
    expect(data.totalDue).toBe(0);
    expect(data.aging.net).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// Concurrency. The INVOICE-ROW claim, not the isolation level, is what makes the over-application
// check and the write it guards see the same state — so the competing caller runs at DEFAULT (Read
// Committed) isolation, where SSI cannot be doing the work (the `applications-concurrency.test.ts`
// technique: script the holder to take PRECISELY the row being discriminated on, and nothing else).
// -------------------------------------------------------------------------------------------

describe("writeOffInvoice concurrency — the invoice-row claim", () => {
  it("blocks a competing Read-Committed write-off on the invoice lock; its fresh read then refuses (not 1400)", async () => {
    const inv = await invoiceFixture({ total: 1000 });

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // HOLDER: Read Committed, taking ONLY the invoice-row claim — deliberately NOT the order claim
    // `writeOffInvoice` also takes, so that removing the invoice claim cannot leave the order lock
    // silently doing the work and keeping this test green.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${inv.invoiceId} FOR UPDATE`;
      await tx.application.create({
        data: {
          invoiceId: inv.invoiceId, amount: 700, type: "WRITE_OFF", reason: "holder",
          appliedDate: parseDateOnly(TODAY),
        },
      });
      hasClaimed();
      await release;
    }, { timeout: 20000 });
    await claimed;

    const competitor = asSystem(() => prisma.$transaction((tx) =>
      writeOffInvoice({ invoiceId: inv.invoiceId, amount: 700, reason: "competitor" }, tx)));

    // Not the discriminator — proof the competitor is genuinely blocked on the held invoice row
    // before the holder commits. With the claim removed it settles almost immediately instead.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      competitor.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    await expect(competitor).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/exceeds the invoice's open balance of 300/),
    });
    const live = await prisma.application.findMany({ where: { invoiceId: inv.invoiceId, deletedAt: null } });
    expect(live).toHaveLength(1); // the holder's 700 alone — the competitor wrote nothing
  });
});

// -------------------------------------------------------------------------------------------
// THE DANGEROUS DIRECTION (the standing invariant). `writeOffInvoice` runs Serializable and fixes
// its snapshot at its FIRST read — before `assertPeriodOpen`'s month read. If a close commits its
// CLOSED row after that snapshot, the write-off's period `findFirst` misses it (no `FOR UPDATE` can
// claim a row that does not exist) and it would post into a just-closed month. ONLY SSI catches
// that, and only while BOTH sides are Serializable.
//
// THE DOWNGRADE WATCH IS TWO TESTS, and it is worth being exact about why, because the obvious
// single test does not do what it looks like it does. The behavioural test below is RED-verified by
// dropping `closePeriod`'s `isolationLevel` (the `close-periods.test.ts` lever): the close becomes
// invisible to SSI, the write-off's stale snapshot misses the CLOSED row, nothing aborts it, and it
// posts into the closed month. It is NOT red when `writeOffInvoice` alone is downgraded — measured,
// not assumed — because a Read Committed write-off takes a FRESH snapshot at its period read and
// therefore SEES the committed close and refuses on the ordinary guard, on THIS interleaving.
//
// Read Committed is not therefore safe, and the claim here is deliberately narrow: that downgrade is
// not RED-ABLE FROM A SOURCE-LEVEL CHANGE, which is a statement about what a test can drive, not
// about what can go wrong (review round 1). The exposure it leaves behind runs the other way round:
// `closePeriod` fixes its own snapshot at `lockMonth`, its first statement, so an RC posting that
// already holds the month advisory lock and commits while the close is blocked on it is invisible to
// SSI — the close then freezes `writeOffTotal`/`endingAr` without it and nothing raises 40001.
// Driving that deterministically would need the real service paused between `assertPeriodOpen` and
// its write, which no source-level edit provides. Hence the structural pin below rather than a
// second behavioural test.
//
// So the write-off's OWN half of the pairing is pinned STRUCTURALLY instead (the
// `tests/attachments.test.ts` `transactionOptions` precedent): the isolation level it opens with is
// asserted directly, and that assertion goes red the moment anyone drops it. Between the two, both
// halves of "the pairing is all-Serializable" are guarded.
// -------------------------------------------------------------------------------------------

/** Records the options every `prisma.$transaction` call receives while `fn` runs. Deliberately NOT
 *  `vi.spyOn` — plain save-reassign-restore is the technique this suite trusts (CLAUDE.md), and it
 *  applies to the client just as it does to its delegates. */
async function transactionOptions(fn: () => Promise<unknown>): Promise<unknown[]> {
  const client = prisma as unknown as Record<string, unknown>;
  const real = client.$transaction as (...a: unknown[]) => unknown;
  const seen: unknown[] = [];
  client.$transaction = (...args: unknown[]) => { seen.push(args[1]); return real.apply(prisma, args); };
  try {
    await fn();
  } finally {
    client.$transaction = real;
  }
  return seen;
}

describe("period-lock concurrency — the Serializable downgrade watch", () => {
  it("STANDING INVARIANT: writeOffInvoice opens exactly one Serializable transaction", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    const opts = await transactionOptions(() => asSystem(() => writeOffInvoice({
      invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable",
    })));
    // One transaction, at Serializable. A Read Committed downgrade breaks the posting-vs-close SSI
    // pairing silently — this is the assertion that refuses to let it happen quietly.
    expect(opts).toEqual([{ isolationLevel: "Serializable" }]);
  });

  it("DANGEROUS direction: a write-off whose snapshot predates a committed close is refused/aborted", async () => {
    // RED-verified by dropping `closePeriod`'s own `isolationLevel` (close-periods.ts): the close
    // stops being visible to SSI, this write-off's stale snapshot misses the CLOSED row, nothing
    // aborts it, and `outcome` becomes "resolved" with a live application inside a closed month.
    const inv = await invoiceFixture({ total: 1000 });

    let gateReady!: () => void;
    const gated = new Promise<void>((r) => { gateReady = r; });
    let releaseGate!: () => void;
    const gateRelease = new Promise<void>((r) => { releaseGate = r; });

    // GATE: Read Committed on purpose — it holds the ORDER row without forming an SSI edge of its
    // own, so the only dangerous structure left is write-off(reads month open) ↔ close(inserts
    // CLOSED). It pauses the real write-off AFTER its snapshot is fixed and BEFORE its period read.
    const gate = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${inv.orderId} FOR UPDATE`;
      gateReady();
      await gateRelease;
    }, { timeout: 20000 });
    await gated;

    const writeOff = asSystem(() => writeOffInvoice({
      invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable",
    })).then(() => "resolved" as const, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200)); // fix the snapshot, then block on the order row

    // The close commits a CLOSED current month while the write-off is paused. Nothing is applied
    // yet, so the month reconciles at the invoice's full 1000.
    const closed = await asSystem(() => closePeriod(CURRENT_YEAR, CURRENT_MONTH));
    expect(closed.status).toBe("CLOSED");
    expect(closed.endingAr).toBe(1000);

    releaseGate();
    await gate;

    const outcome = await writeOff;
    expect(outcome).not.toBe("resolved"); // it must NOT have posted into the closed month
    expect(outcome).toBeInstanceOf(HttpError);
    expect((outcome as HttpError).status).toBe(409); // period-closed OR serialization abort — both 409

    // PROOF: no application leaked, and the frozen close schedule still reads the full receivable.
    expect(await prisma.application.count()).toBe(0);
    const row = await prisma.closePeriod.findFirst({ where: { year: CURRENT_YEAR, month: CURRENT_MONTH } });
    expect(row?.endingAr.toNumber()).toBe(1000);
  });
});
