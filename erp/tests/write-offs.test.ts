import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { writeOffInvoice, voidApplication, openItemsForCustomer } from "@/server/applications";
import { customerReceivablesSummary } from "@/server/customer-receivables";
import { unlockInvoice } from "@/server/invoices";
import { voidOrder } from "@/server/orders";
import { closePeriod, preliminaryReport, reopenPeriod } from "@/server/close-periods";
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
 *  shape a RESIDUAL (payment-sourced) write-off rides alongside.
 *
 *  `dateStr` defaults to TODAY, which is what every pre-#173 caller wants. It is a parameter because
 *  `applyPayment` will not date a receipt into a prior month any more than `writeOffInvoice` will
 *  (both stamp their own date), and #173's subject is precisely a PAYMENT whose month has since
 *  closed — a state the shop reaches by closing the month, not by backdating the receipt. */
async function payInvoice(inv: Fixture, amount: number, dateStr: string = TODAY): Promise<string> {
  seq += 1;
  const on = parseDateOnly(dateStr);
  const batch = await prisma.receiptBatch.create({
    data: { batchNumber: 920000 + seq, depositDate: on },
  });
  const paymentType = await prisma.paymentType.create({ data: { name: `WOPT-${seq}` } });
  const payment = await prisma.payment.create({
    data: {
      batchId: batch.id, customerId: inv.customerId, paymentTypeId: paymentType.id,
      amount, receivedDate: on,
    },
  });
  await prisma.application.create({
    data: { invoiceId: inv.invoiceId, amount, type: "PAYMENT", paymentId: payment.id, appliedDate: on },
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
// #157 — the retention BOUND. Owner ruling 2026-08-19, option (b): the row is kept only while the
// write-off's OWN period is open. The undo it anchors is `voidApplication`, which guards
// `assertPeriodOpen(appliedDate)` — so once that month closes the undo is already dead and the row
// has stopped being a route out of itself.
//
// A standalone write-off dated in a month OTHER than today can only be built with the raw client:
// `writeOffInvoice` stamps `todayDateOnly()` on purpose (a backdate would silently move a prior
// month's aging and roll-forward). Those months' ClosePeriod rows are created raw for the same kind
// of reason — the real `closePeriod` chains from the prior month's frozen ending and would be
// measuring the fixture rather than the retention rule.
// -------------------------------------------------------------------------------------------

/** A CLOSED month with no roll-forward machinery behind it — `period-locks.test.ts`'s helper. */
async function closeMonthRaw(year: number, month: number) {
  return prisma.closePeriod.create({
    data: { year, month, beginningAr: 0, invoicedTotal: 0, creditTotal: 0, paymentTotal: 0,
      discountTotal: 0, writeOffTotal: 0, endingAr: 0, agingEndingAr: 0 },
  });
}

/** A standalone (null-payment) write-off dated whenever the test needs it. */
async function writeOffDated(inv: Fixture, amount: number, dateStr: string, reason: string) {
  return prisma.application.create({
    data: {
      invoiceId: inv.invoiceId, amount, type: "WRITE_OFF", reason,
      paymentId: null, appliedDate: parseDateOnly(dateStr),
    },
  });
}

const idsFor = async (customerId: string) =>
  (await openItemsForCustomer(customerId)).map((i) => i.id);

describe("openItemsForCustomer — retention is bounded by the write-off's own period (#157)", () => {
  // THE COUPLING, pinned in ONE test at the owner's explicit request: the row goes away exactly
  // when the undo it existed for stops working. Two assertions on the same application id, so the
  // pair is by design rather than by coincidence.
  it("hides the row and refuses the void together, once the write-off's month closes", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });

    // While the month is open the row is here AND the void works — the #77 contract, unchanged.
    expect(await idsFor(inv.customerId)).toContain(inv.invoiceId);

    await asSystem(() => closePeriod(CURRENT_YEAR, CURRENT_MONTH));

    expect(await idsFor(inv.customerId)).not.toContain(inv.invoiceId);
    await expect(asSystem(() => voidApplication(app.id, "changed my mind")))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/is closed/) });
    // Nothing was undone on the way past: the write-off is still live, the invoice still settled.
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).deletedAt).toBeNull();
    expect(await openBalance(inv.invoiceId)).toBe(0);
  });

  // Ruling point 2: the reviewer's second retention shape. A PARTIAL standalone write-off, with the
  // remainder later settled in cash, reaches `open <= 0` by a different route and must obey the same
  // rule — keyed on the WRITE-OFF's month, not the invoice's or the payment's.
  it("covers the partial-write-off-then-settled-in-cash shape identically", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 400, reason: "disputed surcharge" }));
    await payInvoice(inv, 600);
    expect(await openBalance(inv.invoiceId)).toBe(0);

    const retained = (await openItemsForCustomer(inv.customerId)).find((i) => i.id === inv.invoiceId);
    expect(retained).toBeDefined();
    expect(retained!.open).toBe(0);
    expect(retained!.writeOffs).toHaveLength(1);

    // Raw, not the real close: `payInvoice` builds its receipt batch with the raw client and never
    // posts it, so the roll-forward would refuse on a variance it is not this test's business to
    // satisfy. The retention read and `assertPeriodOpen` both look for the same CLOSED row.
    await closeMonthRaw(CURRENT_YEAR, CURRENT_MONTH);
    expect(await idsFor(inv.customerId)).not.toContain(inv.invoiceId);
  });

  // The rule keys on the WRITE-OFF's date, never the invoice's — they are routinely different
  // months, and it is the void guard's date that decides whether the undo still works. Closing the
  // INVOICE's month must not hide a row whose write-off is still voidable.
  it("keys on the write-off's month, not the invoice's", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await prisma.invoice.update({
      where: { id: inv.invoiceId },
      data: { invoiceDate: parseDateOnly("2026-01-15"), finalizedAt: parseDateOnly("2026-01-15") },
    });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));

    await closeMonthRaw(2026, 1); // the INVOICE's month is closed; the write-off's is not
    expect(await idsFor(inv.customerId)).toContain(inv.invoiceId);
  });

  // "Any of them, never [0]" — the comment in the retention branch says a later reader will want to
  // simplify this; the test is what stops them. Two standalone write-offs in different months: the
  // row survives while EITHER is voidable, and drops only when both are dead.
  it("retains while ANY standalone write-off is still voidable, across several months", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await writeOffDated(inv, 600, "2026-01-20", "first tranche");
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 400, reason: "the rest" }));
    expect(await openBalance(inv.invoiceId)).toBe(0);

    await closeMonthRaw(2026, 1); // the older one is now un-voidable; today's is not
    const stillListed = (await openItemsForCustomer(inv.customerId)).find((i) => i.id === inv.invoiceId);
    expect(stillListed).toBeDefined();
    // Both are still shown: the closed-month sibling is part of why this row reads the way it does,
    // and its Void refuses with the message that names the month to reopen.
    expect(stillListed!.writeOffs).toHaveLength(2);

    // Raw again: with 2026-01 already closed, a real close of today's month refuses because the
    // months between them are not — a chain rule this test has no stake in.
    await closeMonthRaw(CURRENT_YEAR, CURRENT_MONTH); // now neither is voidable
    expect(await idsFor(inv.customerId)).not.toContain(inv.invoiceId);
  });

  // Ruling point 4, confirmed rather than assumed: a retained row carries `open: 0`, so DROPPING it
  // cannot move the net. #83's sum-to-net property has to hold on BOTH sides of the close.
  it("cannot move the balance — the rows sum to the net before and after the close (#83)", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    const other = await invoiceFixture({ total: 250, customerId: inv.customerId });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));

    const before = await asSystem(() => customerReceivablesSummary(inv.customerId));
    expect(before.aging.net).toBe(250);
    expect(before.openItems.reduce((t, i) => t + Math.round(i.open * 100), 0))
      .toBe(Math.round(before.aging.net * 100));
    expect(before.openItems.map((i) => i.id)).toContain(inv.invoiceId);

    await asSystem(() => closePeriod(CURRENT_YEAR, CURRENT_MONTH));

    const after = await asSystem(() => customerReceivablesSummary(inv.customerId));
    expect(after.aging.net).toBe(250);                       // the net did NOT move
    expect(after.openItems.reduce((t, i) => t + Math.round(i.open * 100), 0))
      .toBe(Math.round(after.aging.net * 100));              // and the rows still sum to it
    expect(after.openItems.map((i) => i.id)).not.toContain(inv.invoiceId);
    expect(after.openItems.map((i) => i.id)).toContain(other.invoiceId);
  });

  // The discriminating negative: a still-OPEN invoice is an open item on its own merits and has
  // nothing to do with the retention branch, so a closed write-off month must not evict it.
  it("does not evict a PARTIALLY written-off invoice that still has a live balance", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await writeOffDated(inv, 400, "2026-01-20", "disputed surcharge");
    await closeMonthRaw(2026, 1);

    const row = (await openItemsForCustomer(inv.customerId)).find((i) => i.id === inv.invoiceId);
    expect(row).toBeDefined();
    expect(row!.open).toBe(600);
    expect(row!.writeOffs).toHaveLength(1);
  });

  // A REOPENED month is open again (§4.1) — the correction route the ruling assumes exists really
  // does bring the row back, which is the other half of "the row is gone because the undo is dead".
  it("brings the row back when the month is REOPENED", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));
    const period = await asSystem(() => closePeriod(CURRENT_YEAR, CURRENT_MONTH));
    expect(await idsFor(inv.customerId)).not.toContain(inv.invoiceId);

    await asSystem(() => reopenPeriod(period.id, "correcting a mis-keyed bad debt"));
    expect(await idsFor(inv.customerId)).toContain(inv.invoiceId);
  });
});

// -------------------------------------------------------------------------------------------
// #174 — the per-write-off `voidable` flag. #157 bounded RETENTION, which covers the settled row:
// once every write-off on it is dead the row leaves the screen. It does not cover the row retained
// on its OWN open balance, which keeps listing its closed-month write-offs — each with a Void that
// always 409s. §5.16's convention is disabled-with-the-reason, never an enabled control that always
// fails, so the row now carries per-write-off whether its undo still works.
//
// Same map, no second read: `closedMonthsForDisplay` is already consulted for the retention
// decision, and retention is now DERIVED from these flags (`writeOffs.some((w) => w.voidable)`) so
// the two cannot disagree about one write-off.
//
// THE CLIENT COMPOSES THE TOOLTIP, and it may not import `periodLabel` (a `"use client"` file must
// not reach into `src/server/**`). It slices `YYYY-MM` off `appliedDate` instead — exact by
// construction, since `formatDateOnly` and `period-locks`' `ym` both read the same UTC date — and
// `names the same month the void refusal names` below is what pins that against drift in either the
// label format or the refusal wording.
// -------------------------------------------------------------------------------------------

/** The tooltip `ReceivablesSection.tsx` renders on a dead Void — composed HERE the way the client
 *  composes it, from the wire fields alone, so the test exercises that derivation rather than a
 *  server-side copy of it. */
// IMPORTED, not re-declared. A local copy of the client's rule pins the copy: it still reds on a
// `periodLabel` format change or an `assertPeriodOpen` re-wording, but a paraphrase in the .tsx
// alone leaves it green — while the comment above it claimed to cover exactly that. Importing the
// real one makes the claim true (#174 review, Minor 1). A "use client" module in a node test is the
// tests/loads-section.test.tsx precedent; this file pulls only the pure string helper.
import { closedPeriodTitle as closedPeriodTitleFor } from "@/app/customers/[id]/ReceivablesSection";

describe("openItemsForCustomer — each write-off says whether its Void still works (#174)", () => {
  // THE DEFECT. An invoice with a live balance is an open item on its own merits, so #157's
  // retention bound never reaches it — and before this its closed-month write-off rendered an
  // ENABLED Void that always 409s. Two write-offs in different months on ONE such row, so the flag
  // is proved per write-off rather than per row: a row-level constant would fail one of the two.
  it("flags each write-off by ITS OWN month, on a row retained for its own open balance", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await writeOffDated(inv, 300, "2026-01-20", "disputed surcharge");
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 200, reason: "the rest" }));
    await closeMonthRaw(2026, 1); // the January one is dead; today's is not

    const row = (await openItemsForCustomer(inv.customerId)).find((i) => i.id === inv.invoiceId)!;
    expect(row.open).toBe(500); // still open on its own merits — #157 never gets a say here
    const byDate = new Map(row.writeOffs.map((w) => [w.appliedDate, w]));
    expect(byDate.get("2026-01-20")!.voidable).toBe(false);
    expect(byDate.get(TODAY)!.voidable).toBe(true);
  });

  // The tooltip has to name the month the operator would actually have to reopen. The client builds
  // it from `appliedDate` alone; this asserts that sentence is character-for-character what
  // `voidApplication` refuses with, so neither `periodLabel`'s format nor `assertPeriodOpen`'s
  // wording can drift away from the tooltip unnoticed.
  it("names the same month the void refusal names", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    const dead = await writeOffDated(inv, 300, "2026-01-20", "disputed surcharge");
    await closeMonthRaw(2026, 1);

    const row = (await openItemsForCustomer(inv.customerId)).find((i) => i.id === inv.invoiceId)!;
    const w = row.writeOffs.find((x) => x.id === dead.id)!;
    expect(w.voidable).toBe(false);
    await expect(asSystem(() => voidApplication(w.id, "changed my mind")))
      .rejects.toMatchObject({ status: 409, message: closedPeriodTitleFor(w) });
  });

  // The retained SETTLED row — #157's own shape — carries the flags too, and this is where the
  // retention rule and the flag meet: the row survives EXACTLY while one of them is `voidable`, so a
  // derived `stillVoidable` cannot drift from what the screen enables. The closed sibling is still
  // listed (it is part of why the row reads the way it does) — just no longer as a live control.
  it("flags the retained settled row's write-offs, and drops the row when the last one dies", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await writeOffDated(inv, 600, "2026-01-20", "first tranche");
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 400, reason: "the rest" }));
    expect(await openBalance(inv.invoiceId)).toBe(0);

    await closeMonthRaw(2026, 1);
    const row = (await openItemsForCustomer(inv.customerId)).find((i) => i.id === inv.invoiceId)!;
    expect(row.open).toBe(0); // retained purely by the live undo, which is the today-dated one
    expect(row.writeOffs.map((w) => w.voidable).sort()).toEqual([false, true]);

    // Raw again (see the section header): with 2026-01 closed, a real close of today's month refuses
    // on the prior-month chain rule this test has no stake in.
    await closeMonthRaw(CURRENT_YEAR, CURRENT_MONTH);
    expect(await idsFor(inv.customerId)).not.toContain(inv.invoiceId);
  });

  // The discriminating negative. #174 adds a flag and a tooltip; it must not change WHICH rows
  // arrive. With nothing closed at all, every write-off is voidable and the #77/#157 set is intact —
  // the settled-but-retained row included.
  it("changes nothing about which rows appear while no month is closed", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    const other = await invoiceFixture({ total: 250, customerId: inv.customerId });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));

    const items = await openItemsForCustomer(inv.customerId);
    expect(items.map((i) => i.id).sort()).toEqual([inv.invoiceId, other.invoiceId].sort());
    const retained = items.find((i) => i.id === inv.invoiceId)!;
    expect(retained.open).toBe(0);
    expect(retained.writeOffs.map((w) => w.voidable)).toEqual([true]);
    expect(items.find((i) => i.id === other.invoiceId)!.writeOffs).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// #157's §5.14 half: the hint has to name a route that EXISTS. `WRITE_OFF_VOID_HINT` used to be one
// unconditional constant pointing at the customer's Receivables section — but `voidApplication`
// refuses a write-off whose own month is closed, so that sentence was already false for those, and
// the retention bound above means the row is not even on that screen any more.
//
// The reachable case is ordinary: `unlockInvoice` guards the INVOICE's `finalizedAt` while a
// write-off is dated at its own creation, so a July-finalized invoice carrying an August write-off
// in a closed August is permitted to TRY the unlock (July is open) — and is then refused by the A/R
// guard, which sends the operator to a Receivables section that refuses the void because August is
// closed. Since the retention bound above, the row is not even listed there.
//
// A live write-off ALWAYS meets the A/R refusal first, whatever the months are:
// `hasReceivableActivity` runs at invoices.ts:1637 and `assertPeriodOpen(finalizedAt)` only at
// :1654. So unlock's own period guard is never what an operator hits while a write-off is live, and
// the hint is the only thing that can tell them where the real wall is. (An earlier draft of this
// comment had that ordering backwards — caught in review.)
//
// #173 WIDENED THE PERIOD HALF TO EVERY KIND. All three refusals fire on ANY live application and
// `voidApplicationInTx` guards `assertPeriodOpen(appliedDate)` for every one of them, so scoping the
// period clause to standalone write-offs left the far commoner blocker — CASH — silently pointing at
// a route that refuses you. The sentence now carries two clauses that share no subject: the ROUTE
// clause (a standing fact about ONE kind, exactly as before) and the PERIOD clause (true of every
// kind, because the guard it restates is kind-blind). Their JOIN is the load-bearing bit — the
// pre-#173 ", but period X is closed — reopen it first" read as though the Receivables route were
// what X blocked, which is false the moment the closed-month row is a payment.
// -------------------------------------------------------------------------------------------

/** The sentence as it reads when everything in scope is still voidable — unchanged since #77, and
 *  pinned here so a widening of the common case cannot slip through. */
const OPEN_ROUTE = " (a bad-debt write-off is voided from the customer's Receivables section)";

describe("the write-off hint names the route that actually exists (#157)", () => {
  it("unlock: keeps today's sentence exactly while the write-off's month is open", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));

    const err = await asSystem(() => unlockInvoice(inv.invoiceId, "correct a line"))
      .catch((e: unknown) => e as HttpError);
    expect((err as HttpError).message).toContain(OPEN_ROUTE);
    expect((err as HttpError).message).not.toMatch(/reopen/);
  });

  it("unlock: names the closed period and the reopen once the write-off's month is closed", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    // The write-off sits in a closed January; the invoice itself is finalized TODAY, so unlock's own
    // `assertPeriodOpen(finalizedAt)` is happy and the A/R refusal is what the operator meets.
    await writeOffDated(inv, 1000, "2026-01-20", "uncollectable");
    await closeMonthRaw(2026, 1);

    const err = await asSystem(() => unlockInvoice(inv.invoiceId, "correct a line"))
      .catch((e: unknown) => e as HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toContain(
      " (a bad-debt write-off is voided from the customer's Receivables section; "
      + "what is applied in closed period 2026-01 cannot be voided until it is reopened)");
    // Refused, not half-applied.
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.invoiceId } })).status).toBe("FINALIZED");
  });

  it("void-order: the ORDER scope reaches the same write-off, and names every closed month", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await writeOffDated(inv, 600, "2026-01-20", "first tranche");
    await writeOffDated(inv, 400, "2026-02-10", "the rest");
    await closeMonthRaw(2026, 2);
    await closeMonthRaw(2026, 1);

    const err = await asSystem(() => voidOrder(inv.orderId, "entered against the wrong customer"))
      .catch((e: unknown) => e as HttpError);
    // Ascending and complete: naming only one of two closed months leaves the operator to discover
    // the second the hard way, and scan order must not decide which one they hear about.
    expect((err as HttpError).message).toContain(
      " (a bad-debt write-off is voided from the customer's Receivables section; "
      + "what is applied in closed periods 2026-01, 2026-02 cannot be voided until they are reopened)");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: inv.orderId } })).deletedAt).toBeNull();
  });

  it("void-order: keeps today's sentence when the closed month holds no write-off of this order's", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));
    await closeMonthRaw(2026, 1); // a closed month, but nothing of this order's is dated in it

    const err = await asSystem(() => voidOrder(inv.orderId, "entered against the wrong customer"))
      .catch((e: unknown) => e as HttpError);
    expect((err as HttpError).message).toContain(OPEN_ROUTE);
    expect((err as HttpError).message).not.toMatch(/reopen/);
  });

  // A RESIDUAL write-off is voided from its receipt batch, NOT from the Receivables section — which
  // is why (since #179) the ROUTE clause is dropped for it: it carries a `paymentId`, so it is not
  // the standalone kind that route names. But its void is refused by the same kind-blind
  // `assertPeriodOpen(appliedDate)`, so the PERIOD clause covers it. Before #173 the closed month
  // behind the residual row was simply not mentioned, and the operator was sent to a batch that
  // refused them with no warning it would; #179 then removes the route clause that was never theirs.
  it("counts a payment-sourced residual write-off — period clause yes, route clause no (#179)", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    const paymentId = await payInvoice(inv, 995);
    await prisma.application.create({
      data: {
        invoiceId: inv.invoiceId, amount: 5, type: "WRITE_OFF", reason: "short pay",
        paymentId, appliedDate: parseDateOnly("2026-01-20"),
      },
    });
    await closeMonthRaw(2026, 1);

    const err = await asSystem(() => unlockInvoice(inv.invoiceId, "correct a line"))
      .catch((e: unknown) => e as HttpError);
    expect((err as HttpError).message).toContain(
      " (what is applied in closed period 2026-01 cannot be voided until it is reopened)");
    expect((err as HttpError).message).not.toContain("Receivables section");
  });
});

// -------------------------------------------------------------------------------------------
// #173 — the period clause is about EVERY live application blocking the refusal, because
// `voidApplicationInTx`'s `assertPeriodOpen(live.appliedDate)` has no type or `paymentId` predicate.
// CASH is the commoner blocker of the three refusals, and before this it was the one the sentence
// said nothing about.
//
// A payment cannot be BACKDATED into a prior month through the services any more than a write-off
// can (`applyPayment` stamps the receipt's own date), so these fixtures build the payment raw —
// `payInvoice(inv, amount, dateStr)` — for the reason its docblock gives: the shop reaches this
// state by CLOSING the month the payment already sits in, not by backdating a receipt.
// -------------------------------------------------------------------------------------------

describe("the period clause covers every live application, not only write-offs (#173)", () => {
  it("unlock: names the closed period when a PAYMENT is what sits in it", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    // No write-off anywhere in scope — cash alone, in a month that has since closed. The invoice is
    // finalized TODAY, so unlock's own `assertPeriodOpen(finalizedAt)` is happy and the A/R refusal
    // is what the operator meets.
    await payInvoice(inv, 400, "2026-01-20");
    await closeMonthRaw(2026, 1);

    const err = await asSystem(() => unlockInvoice(inv.invoiceId, "correct a line"))
      .catch((e: unknown) => e as HttpError);
    expect((err as HttpError).status).toBe(400);
    // #179: cash alone in scope, so the ROUTE clause is dropped — only the period clause remains.
    expect((err as HttpError).message).toContain(
      " (what is applied in closed period 2026-01 cannot be voided until it is reopened)");
    expect((err as HttpError).message).not.toContain("Receivables section");
    // The ROUTE clause must NOT have been re-pointed at the payment on the way past: a payment is
    // voided from its receipt batch, and the sentence never claims otherwise.
    expect((err as HttpError).message).not.toMatch(/payment is voided|batch/i);
    // Refused, not half-applied.
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.invoiceId } })).status).toBe("FINALIZED");
  });

  it("void-order: the ORDER scope reaches the payment too", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await payInvoice(inv, 400, "2026-01-20");
    await closeMonthRaw(2026, 1);

    const err = await asSystem(() => voidOrder(inv.orderId, "entered against the wrong customer"))
      .catch((e: unknown) => e as HttpError);
    expect((err as HttpError).status).toBe(400);
    // #179: cash alone, so the period clause stands alone — no route clause for a payment.
    expect((err as HttpError).message).toContain(
      " (what is applied in closed period 2026-01 cannot be voided until it is reopened)");
    expect((err as HttpError).message).not.toContain("Receivables section");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: inv.orderId } })).deletedAt).toBeNull();
  });

  // THE MIXED SET, the shape the brief singles out: a PAYMENT in one closed month and a STANDALONE
  // write-off in another. Every clause has to survive it — the route clause is true of the write-off
  // and says nothing about the payment; the period clause names BOTH months, ascending, and is true
  // of both rows. This is also why the two clauses share no subject: chained with "but … reopen it
  // first", this sentence would be claiming the Receivables section is what 2026-01 blocks.
  it("names both months when a payment and a write-off sit in different closed ones", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await payInvoice(inv, 400, "2026-01-20");
    await writeOffDated(inv, 600, "2026-02-10", "the rest is uncollectable");
    await closeMonthRaw(2026, 2);
    await closeMonthRaw(2026, 1);

    const err = await asSystem(() => unlockInvoice(inv.invoiceId, "correct a line"))
      .catch((e: unknown) => e as HttpError);
    expect((err as HttpError).message).toBe(
      `Invoice #${inv.orderNumber} has payments, credits or write-offs applied — `
      + "void them before unlocking (a bad-debt write-off is voided from the customer's "
      + "Receivables section; what is applied in closed periods 2026-01, 2026-02 cannot be voided "
      + "until they are reopened)");
  });

  // The discriminating negative on the widened scope: cash in an OPEN month must not start widening
  // the sentence just because the scope now sees it — and (since #179) cash alone carries no route
  // clause either, so a payment-only open-month refusal has no parenthetical tail at all.
  it("carries no tail when the payment's own month is open and no write-off is in scope (#179)", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await payInvoice(inv, 400);                 // TODAY
    await closeMonthRaw(2026, 1);               // a closed month with nothing of this invoice's in it

    const err = await asSystem(() => unlockInvoice(inv.invoiceId, "correct a line"))
      .catch((e: unknown) => e as HttpError);
    // No standalone write-off and nothing of this invoice's in a closed month → neither clause.
    expect((err as HttpError).message).toBe(
      `Invoice #${inv.orderNumber} has payments, credits or write-offs applied — void them before unlocking`);
    expect((err as HttpError).message).not.toContain("Receivables section");
    expect((err as HttpError).message).not.toMatch(/reopen/);
  });

  /**
   * ON THE REFUSAL PATH ONLY. The hint costs two reads and must never run on a successful
   * discard/unlock/void — it is computed inside the `if`, in the `throw` expression, at all three
   * sites. Nothing about the widened scope shows up in a message when there is no refusal, so only a
   * query counter can see the difference between "inside the if" and "hoisted above it".
   *
   * Plain property assignment on the delegate, never `vi.spyOn` (CLAUDE.md: `mockRestore` does not
   * put the original back on this client and corrupts the shared singleton for the rest of the run).
   * **Nothing is restored, and nothing needs to be** — the patch goes on the per-transaction client,
   * which is discarded when the transaction ends, so there is no shared state to leak into the rest
   * of the run. (An earlier draft of this comment promised a `finally` that does not exist, in the
   * file whose whole lesson is comments claiming protection they do not provide.)
   */
  it("costs nothing on a successful unlock — the hint never runs off the refusal path", async () => {
    const inv = await invoiceFixture({ total: 1000 });   // no applications at all: unlock succeeds
    let calls = 0;
    // The counter goes on the TRANSACTION's delegate, and the unlock takes the injected-`tx`
    // signature so it runs on that same client.
    //
    // An earlier version of this test patched the `prisma` singleton and ran the public no-`tx`
    // path. It could not fail. `unlockInvoice` opens `prisma.$transaction(fresh => …)` and the hint
    // queries on `fresh`, whose `.application` is a DIFFERENT object from the singleton's — measured:
    // `tx.application === prisma.application` is false, and the singleton patch observed zero of the
    // transaction's calls. So `calls` was 0 whether the hint sat inside the `if` or above it, and the
    // docblock in invoice-guards.ts cited it as a guarantee. Reviewer-caught; the reason it survived
    // is that this is the one assertion in the file nobody RED-verified, because doing so means
    // hoisting the hint by hand rather than reasoning about it. It has now been hoisted and watched
    // go red.
    //
    // Patching a per-transaction client is also the safe half of CLAUDE.md's `vi.spyOn` rule: the
    // object dies with the transaction, so the shared singleton is never touched at all.
    await asSystem(() => prisma.$transaction(async (tx) => {
      const original = tx.application.findMany.bind(tx.application);
      tx.application.findMany = ((args: unknown) => {
        calls += 1;
        return original(args as Parameters<typeof original>[0]);
      }) as unknown as typeof tx.application.findMany;
      await unlockInvoice(inv.invoiceId, "correct a line", tx);
    }));

    // Non-vacuous on both halves: the unlock really happened (so the path under test ran at all),
    // and it cost no application read (so the hint did not).
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.invoiceId } })).status).toBe("DRAFT");
    expect(calls).toBe(0);
  });

  // The counter's own control. Without this, "0 calls" could mean "the counter never worked" just
  // as easily as "the hint stayed off the path" — the failure that let the previous version pass.
  // A REFUSED unlock must move it.
  it("...and the counter proves it can see the hint: a refused unlock does read applications", async () => {
    const inv = await invoiceFixture({ total: 1000 });
    await asSystem(() => writeOffInvoice({ invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable" }));
    let calls = 0;
    await asSystem(() => prisma.$transaction(async (tx) => {
      const original = tx.application.findMany.bind(tx.application);
      tx.application.findMany = ((args: unknown) => {
        calls += 1;
        return original(args as Parameters<typeof original>[0]);
      }) as unknown as typeof tx.application.findMany;
      await expect(unlockInvoice(inv.invoiceId, "correct a line", tx)).rejects.toMatchObject({ status: 400 });
    }));
    expect(calls).toBeGreaterThan(0);
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
