import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createBatch, getBatch, addPayment, voidPayment, postBatch, voidBatch, listBatches, type BatchDetail } from "@/server/receipts";
import { applyPayment, voidApplication } from "@/server/applications";
import { parseDateOnly } from "@/lib/business-days";
import type { Customer, PaymentType } from "../prisma/generated/prisma/client";

// Task 6 (P5B §4.1/§4.2): a ReceiptBatch is a deposit session holding Payments. `enteredTotal`
// is the live sum, `balance` is what's left to foot against the operator's controlTotal — both
// derived, never stored. A POSTED batch locks payment entry; voiding a payment is a soft delete
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

  it("balance is zero when no control total was set", async () => {
    const batch = await openBatch(null);
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const after = await asSystem(() => addPayment(batch.id, paymentInput(customer, paymentType, 75)));
    expect(after.controlTotal).toBeNull();
    expect(after.enteredTotal).toBe(75);
    expect(after.balance).toBe(0);
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
        message: "This batch is posted — reopen or void a payment to change it",
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
        message: "This batch is posted — reopen or void a payment to change it",
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
    expect(newerRow.balance).toBe(0); // no controlTotal — balance foots against enteredTotal itself
    const olderRow = rows.find((r) => r.id === older.id)!;
    expect(olderRow.enteredTotal).toBe(0);
    expect(olderRow.balance).toBe(500);
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
