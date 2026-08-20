import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createBatch, getBatch, addPayment, voidPayment, postBatch, reopenBatch, voidBatch, listBatches, type BatchDetail } from "@/server/receipts";
import { applyPayment, voidApplication } from "@/server/applications";
import { reopenPeriod, preliminaryReport } from "@/server/close-periods";
import { parseDateOnly, formatDateOnly, todayDateOnly, addDays } from "@/lib/business-days";
import type { Customer, PaymentType } from "../prisma/generated/prisma/client";

// Task 6 (P5B §4.1/§4.2): a ReceiptBatch is a deposit session holding Payments. `enteredTotal`
// is the live sum, `balance` is what's left to foot against the operator's controlTotal — or NULL
// when no control total was set, because nothing has then been proved (#163) — both derived, never
// stored. A POSTED batch locks payment entry; voiding a payment is a soft delete
// with a reason, and voiding an empty batch is too. Applications (Task 7) don't exist yet, so
// every payment's `onAccount` here equals its full `amount`.

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(truncateAll);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `RCC${customerSeq}`, name: `Receipt Customer ${customerSeq}` } });
}

async function makePaymentType(name = "Check"): Promise<PaymentType> {
  return prisma.paymentType.create({ data: { name } });
}

async function openBatch(controlTotal: string | null = null): Promise<BatchDetail> {
  return asSystem(() => createBatch({ depositDate: "2026-08-08", controlTotal }));
}

/** A CLOSED month covering `dateStr`, written directly — the `period-locks.test.ts` precedent.
 *  `closePeriod()` itself would drag in a prior-month close and a zero-variance reconciliation that
 *  none of these tests are about; the guard under test reads only "is there a CLOSED row for this
 *  (year, month)". */
async function closeMonthOf(dateStr: string) {
  const d = parseDateOnly(dateStr);
  return prisma.closePeriod.create({
    data: {
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1,
      beginningAr: 0, invoicedTotal: 0, creditTotal: 0, paymentTotal: 0,
      discountTotal: 0, writeOffTotal: 0, endingAr: 0, agingEndingAr: 0,
    },
  });
}

function paymentInput(customer: Customer, paymentType: PaymentType, amount: number) {
  return {
    customerId: customer.id, paymentTypeId: paymentType.id, amount,
    reference: "1234", receivedDate: "2026-08-08",
  };
}

// -------------------------------------------------------------------------------------------
// Step 1/2: create + add + live balance.
// -------------------------------------------------------------------------------------------

describe("createBatch / getBatch", () => {
  it("creates an OPEN batch with an allocated number and reads it back", async () => {
    const batch = await openBatch("500.00");
    expect(batch.status).toBe("OPEN");
    expect(batch.controlTotal).toBe(500);
    expect(batch.enteredTotal).toBe(0);
    expect(batch.balance).toBe(500);
    expect(batch.payments).toEqual([]);
    expect(batch.deletedAt).toBeNull();
    expect(Number.isInteger(batch.batchNumber)).toBe(true);

    const reread = await asSystem(() => getBatch(batch.id));
    expect(reread).toEqual(batch);
  });

  it("404s a missing batch", async () => {
    await expect(asSystem(() => getBatch("nope"))).rejects.toMatchObject({ status: 404 });
  });
});

describe("addPayment — live balance", () => {
  it("recomputes enteredTotal/balance as payments are added", async () => {
    const batch = await openBatch("500.00");
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();

    const afterFirst = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));
    expect(afterFirst.enteredTotal).toBe(300);
    expect(afterFirst.balance).toBe(200);
    expect(afterFirst.payments).toHaveLength(1);
    const row = afterFirst.payments[0];
    expect(row.customerId).toBe(customer.id);
    expect(row.customerCode).toBe(customer.code);
    expect(row.customerName).toBe(customer.name);
    expect(row.paymentTypeId).toBe(paymentType.id);
    expect(row.paymentTypeName).toBe("Check");
    expect(row.amount).toBe(300);
    expect(row.reference).toBe("1234");
    expect(row.receivedDate).toBe("2026-08-08");
    expect(row.onAccount).toBe(300); // no applications yet (Task 7) — on-account is the full amount

    const afterSecond = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 200)));
    expect(afterSecond.enteredTotal).toBe(500);
    expect(afterSecond.balance).toBe(0);
    expect(afterSecond.payments).toHaveLength(2);
  });

  // #163: with no control total there is nothing to foot against, so `balance` is NULL — "nothing
  // has been proved" — never 0. This assertion read `toBe(0)` for five phases, which was the defect
  // written down as an expectation: a batch checked against nothing rendered exactly like a batch
  // that foots to the cent, on the screen where money is proved.
  it("balance is null when no control total was set — nothing has been proved", async () => {
    const batch = await openBatch(null);
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const after = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 75)));
    expect(after.controlTotal).toBeNull();
    expect(after.enteredTotal).toBe(75);
    expect(after.balance).toBeNull();
  });

  it("refuses an unregistered customer — the FK-writer pattern (assertRefExists)", async () => {
    const batch = await openBatch();
    const paymentType = await makePaymentType();
    await expect(asSystem(() => addPayment(batch.id, {
      customerId: "nope", paymentTypeId: paymentType.id, amount: 10, receivedDate: "2026-08-08",
    }))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/customer does not exist/i) });
    expect(await prisma.payment.count()).toBe(0);
  });

  it("refuses an unregistered payment type", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    await expect(asSystem(() => addPayment(batch.id, {
      customerId: customer.id, paymentTypeId: "nope", amount: 10, receivedDate: "2026-08-08",
    }))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/payment type does not exist/i) });
  });

  it("audits the create with real content — the payment's amount and live FK names", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType("Wire");
    const detail = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 42.5)));
    const paymentId = detail.payments[0].id;
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "payment", entityId: paymentId, action: "create" } });
    expect(entry).not.toBeNull();
    const after = entry!.after as Record<string, unknown>;
    expect(after.amount).toBe(42.5);
    expect(after.customerCode).toBe(customer.code);
    expect(after.paymentTypeName).toBe("Wire");
    expect(after.batchId).toBe(batch.id);
  });
});

// -------------------------------------------------------------------------------------------
// #73 (owner answer Q16, 2026-08-17: "No, not yet" — payments post after the deposit is in
// hand): a future `receivedDate` is refused at the SOLE writer of the column (`addPaymentInTx`;
// there is no updatePayment, and voidPayment only stamps `deletedAt`). Today and the past stay
// legal — the guard is strictly "not the future", never a staleness window.
// -------------------------------------------------------------------------------------------

describe("addPayment — refuses a future received date (#73)", () => {
  it("400s tomorrow with the exact message, and writes nothing", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await expect(asSystem(() => addPayment(batch.id, {
      ...paymentInput(customer, paymentType, 100),
      receivedDate: formatDateOnly(addDays(todayDateOnly(), 1)),
    }))).rejects.toMatchObject({
      status: 400,
      message: "The received date must be on or before today — payments are entered after the deposit is in hand",
    });
    expect(await prisma.payment.count()).toBe(0);
  });

  it("accepts today — the boundary is on-or-before, not strictly-before", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const after = await asSystem(() => addPayment(batch.id, {
      ...paymentInput(customer, paymentType, 100),
      receivedDate: formatDateOnly(todayDateOnly()),
    }));
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0].receivedDate).toBe(formatDateOnly(todayDateOnly()));
  });

  it("accepts yesterday — the ordinary after-the-deposit entry", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const yesterday = formatDateOnly(addDays(todayDateOnly(), -1));
    const after = await asSystem(() => addPayment(batch.id, {
      ...paymentInput(customer, paymentType, 100), receivedDate: yesterday,
    }));
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0].receivedDate).toBe(yesterday);
  });
});

// -------------------------------------------------------------------------------------------
// Fix #11 (Round 4 correction-path): the batch detail must carry each payment's LIVE applications
// so the UI can list them — and offer a void — without a second endpoint. `invoiceDocumentNumber`
// is the prefix + order-number rule; a voided application drops out without disturbing the payment.
// -------------------------------------------------------------------------------------------

describe("readBatchDetail — a payment's live applications", () => {
  it("lists a live PAYMENT application with its invoice's document number, and drops a voided one", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const afterAdd = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));
    const paymentId = afterAdd.payments[0].id;

    const order = await prisma.order.create({
      data: {
        orderNumber: 970000 + customerSeq, customerId: customer.id, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
        invoiceDate: parseDateOnly("2026-08-08"), total: 300, finalizedAt: new Date(),
      },
    });
    await asSystem(() => applyPayment({ paymentId, lines: [{ invoiceId: invoice.id, type: "PAYMENT", amount: 100 }] }));

    const detail = await asSystem(() => getBatch(batch.id));
    const paymentRow = detail.payments[0];
    expect(paymentRow.applications).toHaveLength(1);
    const app = paymentRow.applications[0];
    expect(app.type).toBe("PAYMENT");
    expect(app.amount).toBe(100);
    expect(app.invoiceId).toBe(invoice.id);
    expect(app.invoiceDocumentNumber).toBe(String(order.orderNumber)); // blank prefix by default

    // Voiding the application drops it from the list — the payment itself stays live and untouched.
    await asSystem(() => voidApplication(app.id, "test correction"));
    const afterVoid = await asSystem(() => getBatch(batch.id));
    expect(afterVoid.payments).toHaveLength(1);
    expect(afterVoid.payments[0].applications).toHaveLength(0);
    expect(afterVoid.payments[0].onAccount).toBe(300); // restored — the same ar-balances derivation
  });
});

// -------------------------------------------------------------------------------------------
// Step 5/7: post locks payment entry.
// -------------------------------------------------------------------------------------------

describe("postBatch — locks payment entry", () => {
  it("posts an OPEN batch, then refuses addPayment and a second post", async () => {
    const batch = await openBatch("100.00");
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 100)));

    const posted = await asSystem(() => postBatch(batch.id));
    expect(posted.status).toBe("POSTED");

    await expect(asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 5))))
      .rejects.toMatchObject({
        status: 400,
        message: "This batch is posted — reopen it first to change it",
      });

    await expect(asSystem(() => postBatch(batch.id)))
      .rejects.toMatchObject({ status: 400, message: "already posted" });
  });

  it("audits the post with the status before/after", async () => {
    const batch = await openBatch();
    await asSystem(() => postBatch(batch.id));
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "receiptBatch", entityId: batch.id, action: "update" } });
    expect((entry!.before as Record<string, unknown>).status).toBe("OPEN");
    expect((entry!.after as Record<string, unknown>).status).toBe("POSTED");
  });
});

// -------------------------------------------------------------------------------------------
// #80 (owner answer Q18, 2026-08-17: refusing is the safer default): posting a batch whose
// NON-NULL controlTotal does not foot against the live payment sum is refused under the batch
// claim, with a message naming both figures and the difference (shown as its absolute value —
// over vs under is readable from the two figures). Null controlTotal posts freely (balance is null
// — nothing to prove against, #163), and voided payments never count — every sum in this file
// filters `deletedAt: null`.
// `controlTotal` is immutable (createBatch is its only writer; the batch header has no edit
// path), so the refusal names the two ways out (§5.14): enter the missing payments, or void and
// re-key.
// -------------------------------------------------------------------------------------------

describe("postBatch — refuses an un-footed control total (#80)", () => {
  it("refuses an under-entered batch, naming control, entered and the difference — and stays OPEN", async () => {
    const batch = await openBatch("500.00");
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));

    await expect(asSystem(() => postBatch(batch.id))).rejects.toMatchObject({
      status: 400,
      message: "This batch does not balance — control total 500.00, payments entered 300.00 " +
        "(difference 200.00). Enter the missing payments, or void this batch and re-key it " +
        "with the correct control total.",
    });
    expect((await prisma.receiptBatch.findUnique({ where: { id: batch.id } }))!.status).toBe("OPEN");
  });

  it("refuses an over-entered batch — absolute difference, and the remedy flips to void-the-extra", async () => {
    const batch = await openBatch("100.00");
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));

    await expect(asSystem(() => postBatch(batch.id))).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("control total 100.00, payments entered 300.00 (difference 200.00)"),
    });
    // Over-entered wants the extra payment voided, not more payments keyed (review r1 minor).
    await expect(asSystem(() => postBatch(batch.id))).rejects.toMatchObject({
      message: expect.stringContaining("Void the extra payment,"),
    });
  });

  it("posts when the batch foots to the cent", async () => {
    const batch = await openBatch("300.00");
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 200)));
    await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 100)));

    const posted = await asSystem(() => postBatch(batch.id));
    expect(posted.status).toBe("POSTED");
  });

  // The posting rule is deliberately unchanged by #163: a batch with no control total still posts
  // freely (owner answer Q18). What changed is only what the screen SAYS about it — `balance` is
  // null, not a reassuring 0.
  it("posts freely with no control total — balance is null, nothing to prove against", async () => {
    const batch = await openBatch(null);
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const added = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));
    expect(added.balance).toBeNull();

    const posted = await asSystem(() => postBatch(batch.id));
    expect(posted.status).toBe("POSTED");
    expect(posted.balance).toBeNull();
  });

  it("refuses a batch that footed and then had a payment VOIDED — the voided payment never counts", async () => {
    const batch = await openBatch("300.00");
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 200)));
    const footed = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 100)));
    expect(footed.balance).toBe(0); // it foots right now

    const hundred = footed.payments.find((p) => p.amount === 100)!;
    await asSystem(() => voidPayment(batch.id, hundred.id, "mis-keyed"));

    await expect(asSystem(() => postBatch(batch.id))).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("control total 300.00, payments entered 200.00 (difference 100.00)"),
    });
  });

  it("refuses an EMPTY batch with a non-null control total", async () => {
    const batch = await openBatch("500.00");
    await expect(asSystem(() => postBatch(batch.id))).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("control total 500.00, payments entered 0.00 (difference 500.00)"),
    });
  });
});

/**
 * `reopenBatch` — POSTED -> OPEN. Owner ruling, 2026-08-16 (issue #68, option b): a mis-keyed
 * deposit must be correctable without a compensating entry, and this is the escape hatch
 * `refusePosted`'s message promised for two phases before it existed.
 *
 * It is a POSTING MUTATION, so the interesting cases are not "does the status flip" but the period
 * guard: reopening a batch whose cash sits in a CLOSED month would silently change frozen figures —
 * the exact leak the period lock exists to close.
 */
describe("reopenBatch — POSTED -> OPEN (#68)", () => {
  it("flips a posted batch back to OPEN and re-allows payment entry", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 100)));
    await asSystem(() => postBatch(batch.id));

    const reopened = await asSystem(() => reopenBatch(batch.id, "keyed the wrong deposit date"));
    expect(reopened.status).toBe("OPEN");

    // The whole point: the payment list is editable again, both directions.
    const afterAdd = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 5)));
    expect(afterAdd.payments).toHaveLength(2);
    const corrected = await asSystem(() => voidPayment(batch.id, afterAdd.payments[0].id, "mis-keyed"));
    expect(corrected.payments).toHaveLength(1);
  });

  it("requires a non-blank reason, and records it on the audit entry", async () => {
    const batch = await openBatch();
    await asSystem(() => postBatch(batch.id));
    await expect(asSystem(() => reopenBatch(batch.id, "   "))).rejects.toThrow(/reason/i);

    await asSystem(() => reopenBatch(batch.id, "deposit slip did not foot"));
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "receiptBatch", entityId: batch.id, action: "update" },
      orderBy: { at: "desc" }, // the post's own entry is the older of the two
    });
    expect((entry!.before as Record<string, unknown>).status).toBe("POSTED");
    expect((entry!.after as Record<string, unknown>).status).toBe("OPEN");
    expect(entry!.reason).toBe("deposit slip did not foot");
  });

  it("refuses an already-OPEN batch — the postBatch idempotent-refusal shape, never a second write", async () => {
    const batch = await openBatch();
    await expect(asSystem(() => reopenBatch(batch.id, "why")))
      .rejects.toMatchObject({ status: 400, message: "already open" });
    // No empty-diff audit row for a refused no-op.
    expect(await prisma.auditLog.count({
      where: { entity: "receiptBatch", entityId: batch.id, action: "update" } })).toBe(0);
  });

  it("404s a voided batch", async () => {
    const batch = await openBatch();
    await asSystem(() => voidBatch(batch.id, "duplicate"));
    await expect(asSystem(() => reopenBatch(batch.id, "why"))).rejects.toMatchObject({ status: 404 });
  });

  /**
   * THE GUARD THAT MATTERS. A batch whose payment sits in a month that has since been CLOSED must
   * not reopen — un-posting it would drop that cash out of `buildCurrentJournal`'s recognition and
   * silently change a frozen figure. `postBatch` already refuses INTO a closed month; the inverse
   * has to refuse for the same reason, or the freeze is one-directional and therefore not a freeze.
   *
   * RED-verified by deleting the `assertBatchMonthsOpen` call from `reopenBatchInTx`: the reopen
   * succeeds against the closed month and this test fails on the 409 that never comes.
   */
  it("refuses to reopen a batch whose cash lands in a CLOSED month", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 100)));
    await asSystem(() => postBatch(batch.id));

    // The payment's receivedDate is 2026-08-08 (paymentInput) — close that month.
    await closeMonthOf("2026-08-08");

    await expect(asSystem(() => reopenBatch(batch.id, "mis-keyed")))
      .rejects.toMatchObject({ status: 409 });
    expect((await prisma.receiptBatch.findUnique({ where: { id: batch.id } }))!.status).toBe("POSTED");
  });

  /**
   * The correction path the 5C GL-export consequence on #68 called for: reopening the PERIOD must
   * make the batch reopenable again, so mis-keyed posted cash can actually be corrected and the
   * correction can flow through the export delta. A REOPENED ClosePeriod row is not CLOSED and does
   * not block (period-locks.ts, §4.1) — this pins that the two reopens compose.
   */
  it("reopens once the period is reopened — period reopen, then batch reopen", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 100)));
    await asSystem(() => postBatch(batch.id));

    const closed = await closeMonthOf("2026-08-08");
    await asSystem(() => reopenPeriod(closed.id, "correcting a mis-keyed deposit"));

    const reopened = await asSystem(() => reopenBatch(batch.id, "mis-keyed"));
    expect(reopened.status).toBe("OPEN");
  });

  /**
   * APPLIED CASH — deliberately NOT guarded, and this test is the record of that decision.
   *
   * `voidPayment` refuses a payment holding live applications because voiding STRANDS them: the
   * payment disappears while the invoice still reads settled over an application sourced from it.
   * Reopening strands nothing — payment, applications and invoice balance all survive intact
   * (`ar-balances` derives from live `Application` rows and never looks at batch status), so the
   * A/R sub-ledger is unmoved. That is why the symmetric guard is not copied here.
   *
   * What DOES move is GL recognition: `buildCurrentJournal` recognizes a PAYMENT only while its
   * batch is POSTED, and the close's roll-forward scopes `paymentTotal` the same way
   * (`close-periods.ts`), while the aging it reconciles against does not. So a month left with a
   * reopened batch reconciles short and `closePeriod` refuses on a nonzero variance — the operator
   * must re-post before closing. Loud, not silent, which is the whole design of that reconciliation.
   * (A PAYMENT-type application is not itself a journal event — only DISCOUNT/WRITE_OFF are — so
   * nothing double-counts.)
   */
  it("reopens a batch whose payment is applied, stranding nothing — balances and applications survive", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const afterAdd = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));
    const paymentId = afterAdd.payments[0].id;

    const order = await prisma.order.create({
      data: {
        orderNumber: 960000 + customerSeq, customerId: customer.id, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
        invoiceDate: parseDateOnly("2026-08-08"), total: 300, finalizedAt: new Date(),
      },
    });
    await asSystem(() => applyPayment({ paymentId, lines: [{ invoiceId: invoice.id, type: "PAYMENT", amount: 300 }] }));
    await asSystem(() => postBatch(batch.id));

    const reopened = await asSystem(() => reopenBatch(batch.id, "wrong deposit total"));
    expect(reopened.status).toBe("OPEN");

    // Nothing stranded: the application is still live and the payment still shows zero on-account.
    expect(await prisma.application.count({ where: { paymentId, deletedAt: null } })).toBe(1);
    expect(reopened.payments[0].onAccount).toBe(0);
    expect(reopened.payments[0].applications).toHaveLength(1);

    // And the payment list is editable again only through the applications-first path `voidPayment`
    // already enforces — reopening did not weaken that guard.
    await expect(asSystem(() => voidPayment(batch.id, paymentId, "mis-keyed")))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/applications/i) });
  });

  /**
   * ...and the SAFETY NET that justifies not guarding it, verified rather than asserted.
   *
   * The reasoning above rests on a claim: a month left with a reopened batch cannot be closed
   * quietly, because the roll-forward's `paymentTotal` scopes to POSTED batches while the aging it
   * reconciles against does not, so the two derivations diverge and the close refuses on a nonzero
   * variance. Both halves are readable in the source, but "the two premises are true so the
   * conclusion holds" is exactly the kind of inference this project has been burned by. So this
   * measures the variance directly, through `preliminaryReport` — the same schedule `closePeriod`
   * reconciles, without needing the advisory locks or a genesis close.
   */
  it("makes the month refuse to reconcile until it is re-posted — the reopen cannot close quietly", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const afterAdd = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));
    const order = await prisma.order.create({
      data: {
        orderNumber: 970000 + customerSeq, customerId: customer.id, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
        invoiceDate: parseDateOnly("2026-08-08"), total: 300, finalizedAt: new Date(),
      },
    });
    await asSystem(() => applyPayment({
      paymentId: afterAdd.payments[0].id, lines: [{ invoiceId: invoice.id, type: "PAYMENT", amount: 300 }] }));
    await asSystem(() => postBatch(batch.id));

    // Posted: invoiced 300, payments 300, ending A/R 0 — and the aging agrees, so it reconciles.
    const before = await asSystem(() => preliminaryReport(2026, 8));
    expect(before.schedule.paymentTotal).toBe(300);
    expect(before.schedule.variance).toBe(0);

    await asSystem(() => reopenBatch(batch.id, "wrong deposit total"));

    // Reopened: the cash drops out of the roll-forward while the aging still sees the invoice
    // settled, so the month is off by exactly the reopened amount and `closePeriod` would 409.
    const after = await asSystem(() => preliminaryReport(2026, 8));
    expect(after.schedule.paymentTotal).toBe(0);
    expect(after.schedule.agingEndingAr).toBe(before.schedule.agingEndingAr); // the sub-ledger did not move
    expect(after.schedule.variance).toBe(300);
    expect(after.unpostedBatchCount).toBe(1); // and the preview names the batch to re-post
  });

  /**
   * A batch can span months (`postBatch`'s own comment), and `assertBatchMonthsOpen` guards EVERY
   * one of them. Closing only the SECOND month must still block the reopen — a guard that checked
   * one payment, or only the earliest month, would pass here.
   */
  it("refuses when ANY of a multi-month batch's months is closed, not just the first", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(batch.id, { ...paymentInput(customer, paymentType, 50), receivedDate: "2026-07-20" }));
    await asSystem(() => addPayment(batch.id, { ...paymentInput(customer, paymentType, 50), receivedDate: "2026-08-08" }));
    await asSystem(() => postBatch(batch.id));

    await closeMonthOf("2026-08-08"); // the LATER month only

    await expect(asSystem(() => reopenBatch(batch.id, "mis-keyed")))
      .rejects.toMatchObject({ status: 409 });
  });
});

// -------------------------------------------------------------------------------------------
// Step 8/9: void payment, void batch.
// -------------------------------------------------------------------------------------------

describe("voidPayment", () => {
  it("requires a non-blank reason", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const afterAdd = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));
    const paymentId = afterAdd.payments[0].id;
    await expect(asSystem(() => voidPayment(batch.id, paymentId, "   "))).rejects.toThrow(/reason/i);
    expect(await prisma.payment.count({ where: { deletedAt: null } })).toBe(1);
  });

  it("soft-deletes with a reason and drops the payment from enteredTotal", async () => {
    const batch = await openBatch("500.00");
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const afterAdd = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));
    const paymentId = afterAdd.payments[0].id;

    const afterVoid = await asSystem(() => voidPayment(batch.id, paymentId, "entered against the wrong batch"));
    expect(afterVoid.payments).toHaveLength(0);
    expect(afterVoid.enteredTotal).toBe(0);
    expect(afterVoid.balance).toBe(500);

    const entry = await prisma.auditLog.findFirst({
      where: { entity: "payment", entityId: paymentId, action: "delete" } });
    expect(entry!.reason).toBe("entered against the wrong batch");
  });

  it("refuses to void a payment on a POSTED batch", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const afterAdd = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));
    const paymentId = afterAdd.payments[0].id;
    await asSystem(() => postBatch(batch.id));
    await expect(asSystem(() => voidPayment(batch.id, paymentId, "mistake")))
      .rejects.toMatchObject({
        status: 400,
        message: "This batch is posted — reopen it first to change it",
      });
  });

  // Whole-branch FIX 2: the symmetric guard. A payment with live applications must not be voided
  // out from under them — that would strand the live `Application` (the invoice still reads settled)
  // while the payment's cash vanishes from on-account. Void the application first, then the payment.
  it("refuses a payment that still has a live application, then voids cleanly once it is gone", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const afterAdd = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));
    const paymentId = afterAdd.payments[0].id;

    // A finalized invoice for the same customer, and the payment applied to it in full.
    const order = await prisma.order.create({
      data: {
        orderNumber: 940000 + customerSeq, customerId: customer.id, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
        invoiceDate: parseDateOnly("2026-08-08"), total: 300, finalizedAt: new Date(),
      },
    });
    await asSystem(() => applyPayment({ paymentId, lines: [{ invoiceId: invoice.id, type: "PAYMENT", amount: 300 }] }));

    // voidPayment refuses — the live application would be stranded (non-vacuous: without the guard
    // this call would succeed).
    await expect(asSystem(() => voidPayment(batch.id, paymentId, "wrong batch")))
      .rejects.toMatchObject({ status: 400, message: "This payment has applications — void them first" });
    expect(await prisma.payment.count({ where: { id: paymentId, deletedAt: null } })).toBe(1); // still live

    // Void the application, then the payment voids cleanly with the reason recorded in the audit entry.
    const app = await prisma.application.findFirstOrThrow({ where: { paymentId } });
    await asSystem(() => voidApplication(app.id, "misapplied to the wrong invoice"));
    const afterVoid = await asSystem(() => voidPayment(batch.id, paymentId, "entered against the wrong batch"));
    expect(afterVoid.payments).toHaveLength(0);
    expect(await prisma.payment.count({ where: { id: paymentId, deletedAt: null } })).toBe(0);

    const entry = await prisma.auditLog.findFirst({
      where: { entity: "payment", entityId: paymentId, action: "delete" } });
    expect(entry!.reason).toBe("entered against the wrong batch");
  });
});

describe("voidBatch", () => {
  it("requires a non-blank reason", async () => {
    const batch = await openBatch();
    await expect(asSystem(() => voidBatch(batch.id, "   "))).rejects.toThrow(/reason/i);
  });

  it("refuses to void a batch that still has live payments", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 10)));
    await expect(asSystem(() => voidBatch(batch.id, "mistake")))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/void its payments first/i) });
    expect((await prisma.receiptBatch.findUnique({ where: { id: batch.id } }))!.deletedAt).toBeNull();
  });

  // Issue #68. `voidBatch` had NO posted guard, so an EMPTY posted batch was voidable while a
  // NON-EMPTY one was frozen solid — payments un-voidable by `refusePosted`, batch un-voidable by
  // the live-payment guard. Both posted shapes now refuse identically, and both name `reopen`.
  it("refuses to void a POSTED batch — empty or not — and names reopen as the way out", async () => {
    const empty = await openBatch();
    await asSystem(() => postBatch(empty.id));
    await expect(asSystem(() => voidBatch(empty.id, "duplicate")))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/posted — reopen it first to void it/i) });
    expect((await prisma.receiptBatch.findUnique({ where: { id: empty.id } }))!.deletedAt).toBeNull();

    const filled = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(filled.id, paymentInput(customer, paymentType, 10)));
    await asSystem(() => postBatch(filled.id));
    // POSTED is checked BEFORE the live-payment guard, deliberately: "void its payments first" would
    // send the operator at a control `refusePosted` refuses — the dead end #68 is about.
    await expect(asSystem(() => voidBatch(filled.id, "duplicate")))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/reopen it first to void it/i) });
  });

  it("voids a posted EMPTY batch once it is reopened — the full escape hatch", async () => {
    const batch = await openBatch();
    await asSystem(() => postBatch(batch.id));
    await asSystem(() => reopenBatch(batch.id, "keyed the wrong deposit date"));
    await asSystem(() => voidBatch(batch.id, "duplicate deposit entry"));
    expect((await prisma.receiptBatch.findUnique({ where: { id: batch.id } }))!.deletedAt).not.toBeNull();
  });

  it("soft-deletes an empty batch with the reason recorded in the audit entry", async () => {
    const batch = await openBatch();
    await asSystem(() => voidBatch(batch.id, "duplicate deposit entry"));
    const row = await prisma.receiptBatch.findUnique({ where: { id: batch.id } });
    expect(row!.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "receiptBatch", entityId: batch.id, action: "delete" } });
    expect(entry!.reason).toBe("duplicate deposit entry");
  });
});

// -------------------------------------------------------------------------------------------
// listBatches — Task 13's worklist. Not part of Task 6's original surface; see the file-header
// comment on `listBatches` in receipts.ts for why it was added here after the fact.
// -------------------------------------------------------------------------------------------

describe("listBatches", () => {
  it("lists live batches newest-first with their live totals", async () => {
    const older = await asSystem(() => createBatch({ depositDate: "2026-08-01", controlTotal: "500.00" }));
    const newer = await asSystem(() => createBatch({ depositDate: "2026-08-08", controlTotal: null }));
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(newer.id, paymentInput(customer, paymentType, 300)));

    const rows = await listBatches();
    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]); // depositDate desc
    const newerRow = rows.find((r) => r.id === newer.id)!;
    expect(newerRow.enteredTotal).toBe(300);
    expect(newerRow.balance).toBeNull(); // #163: no controlTotal — nothing was proved against
    const olderRow = rows.find((r) => r.id === older.id)!;
    expect(olderRow.enteredTotal).toBe(0);
    expect(olderRow.balance).toBe(500);
  });

  /**
   * #163: the two "zeros" must never collapse into each other again. A batch whose control total
   * FOOTS reports a real `0` (proved, and it agrees); a batch with no control total reports `null`
   * (nothing to prove against). Pinned on BOTH read shapes in one test — `toBatchListRow` and
   * `toBatchDetail` each carried their own copy of the old arithmetic, and only one of them being
   * fixed is the exact half-migration that would leave the list screen still lying.
   *
   * A `?? 0` reintroduced on either side reds this rather than silently restoring the defect.
   */
  it("distinguishes a footed 0 from an unproved null — both read shapes", async () => {
    const proved = await asSystem(() => createBatch({ depositDate: "2026-08-02", controlTotal: "300.00" }));
    const unproved = await asSystem(() => createBatch({ depositDate: "2026-08-01", controlTotal: null }));
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    await asSystem(() => addPayment(proved.id, paymentInput(customer, paymentType, 300)));
    await asSystem(() => addPayment(unproved.id, paymentInput(customer, paymentType, 300)));

    const rows = await listBatches();
    expect(rows.find((r) => r.id === proved.id)!.balance).toBe(0);
    expect(rows.find((r) => r.id === unproved.id)!.balance).toBeNull();

    expect((await asSystem(() => getBatch(proved.id))).balance).toBe(0);
    expect((await asSystem(() => getBatch(unproved.id))).balance).toBeNull();
  });

  it("filters by status", async () => {
    const open = await asSystem(() => createBatch({ depositDate: "2026-08-08", controlTotal: null }));
    const posted = await asSystem(() => createBatch({ depositDate: "2026-08-08", controlTotal: null }));
    await asSystem(() => postBatch(posted.id));

    expect((await listBatches({ status: "OPEN" })).map((r) => r.id)).toEqual([open.id]);
    expect((await listBatches({ status: "POSTED" })).map((r) => r.id)).toEqual([posted.id]);
  });

  it("excludes a voided batch", async () => {
    const batch = await asSystem(() => createBatch({ depositDate: "2026-08-08", controlTotal: null }));
    await asSystem(() => voidBatch(batch.id, "duplicate"));
    expect(await listBatches()).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// Whole-branch FIX (residual window): voidPayment vs a racing applyPayment on the SAME payment.
// voidPayment claims the BATCH row; applyPayment claims the PAYMENT row — different rows, so the
// two only serialize once voidPayment ALSO claims the payment row (the fix). Without that claim
// voidPayment's live-applications check can read zero apps while applyPayment is mid-write, then
// void the payment and STRAND the application (payment voided AND application live).
//
// The discipline (the applications-concurrency.test.ts precedent): a passing concurrency test
// proves nothing on its own — two Serializable txns are SSI-ordered regardless. So SSI is off the
// table: the COMPETING caller (voidPayment) runs at DEFAULT (Read Committed), where the ONLY thing
// that can serialize it against the holder is a genuine row lock. The holder is HAND-SCRIPTED to
// hold PRECISELY the payment-row `FOR UPDATE` claim (the lock under test — NOT the batch lock, which
// voidPayment takes first and which would otherwise do the serializing) and to write a PAYMENT
// application against it while uncommitted, so the competitor's serialization comes from nothing but
// its OWN payment claim.
//
// Verified RED by hand by commenting out the payment-row `FOR UPDATE` claim in `voidPaymentInTx`:
// the competitor then never blocks — its Read-Committed applications read sees zero committed apps,
// it voids the payment and settles immediately (the TIMED_OUT assertion fails first), leaving the
// payment voided AND the holder's application live. Restored → GREEN (transcript in the whole-branch
// fix report).
describe("voidPayment concurrency — the payment-row claim serializes a void against a racing application", () => {
  it("blocks the competing Read-Committed void on the payment lock; the fresh read then refuses (never a voided payment with a live application)", async () => {
    const batch = await openBatch();
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const afterAdd = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 300)));
    const paymentId = afterAdd.payments[0].id;

    // A finalized invoice for the same customer — the holder applies the payment to it.
    const order = await prisma.order.create({
      data: {
        orderNumber: 950000 + customerSeq, customerId: customer.id, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
        invoiceDate: parseDateOnly("2026-08-08"), total: 300, finalizedAt: new Date(),
      },
    });

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // The holder simulates `applyPayment`'s effect: it takes ONLY the payment-row `FOR UPDATE` claim
    // (deliberately not the batch lock — see the block header), writes a 300 PAYMENT application
    // against the payment, then holds it uncommitted. Read Committed: the application is invisible to
    // the competitor's applications read until this commits, so the competitor can only see it after
    // it acquires the payment lock — which is exactly the serialization under test.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;
      await tx.application.create({
        data: {
          invoiceId: invoice.id, amount: 300, type: "PAYMENT", paymentId,
          appliedDate: parseDateOnly("2026-08-08"),
        },
      });
      hasClaimed();
      await release;
    }, { timeout: 20000 });

    await claimed;

    // The competitor: `voidPayment` on a manually-opened DEFAULT (Read Committed) transaction — NOT
    // the public Serializable path, so SSI is out of the picture and the payment-row claim is the
    // only thing that can serialize it.
    const competitor = asSystem(() => prisma.$transaction((tx) =>
      voidPayment(batch.id, paymentId, "wrong batch", tx)));

    // Not the discriminator — just proof the competitor's own payment claim is genuinely blocked on
    // the holder. In the regression (claim removed) it never blocks: it reads zero committed apps and
    // settles almost immediately, so THIS assertion fails first.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      competitor.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    // The discriminator: with the payment row locked, the competitor could decide nothing until the
    // holder's application committed. Its fresh Read-Committed read then sees that live application
    // and REFUSES the void — deterministically this exact 400, never a voided payment with a live
    // application against it.
    await expect(competitor).rejects.toMatchObject({
      status: 400,
      message: "This payment has applications — void them first",
    });

    // Exactly one outcome: the payment stays live (the void refused) and the holder's application
    // stays live — never both a voided payment AND a live application.
    expect(await prisma.payment.count({ where: { id: paymentId, deletedAt: null } })).toBe(1);
    expect(await prisma.application.count({ where: { paymentId, deletedAt: null } })).toBe(1);
  });
});
