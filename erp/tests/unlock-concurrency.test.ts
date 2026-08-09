import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { unlockInvoice } from "@/server/invoices";
import { parseDateOnly } from "@/lib/business-days";

// Task 9 (brief Step 5): a payment application racing an unlock of the SAME finalized invoice. The
// two operations both claim the invoice's order AND the invoice row, so they serialize on that
// claim; the loser must refuse. What must NEVER happen is both committing — an invoice unlocked back
// to DRAFT WITH a live `Application` still sitting against it, which is precisely the editable-paper-
// with-money-on-it state Task 9's guard exists to forbid.
//
// The discipline (global-constraints.md / the applications-concurrency.test.ts precedent): a passing
// concurrency test proves nothing on its own. Two Serializable transactions are ordered by
// Postgres's own SSI whether or not the row lock exists, so a green run under two Serializable
// callers would prove SSI, not the invoice-row `FOR UPDATE` claim `unlockInvoice` takes. So SSI is
// taken off the table entirely — the COMPETING caller (`unlockInvoice`, passed a manually-opened
// transaction) runs at DEFAULT (Read Committed) isolation, where there is no whole-transaction
// snapshot and the ONLY thing that can serialize it against the holder is a genuine row lock.
//
// The holder is HAND-SCRIPTED to hold PRECISELY the invoice-row `FOR UPDATE` claim — deliberately
// NOT the order lock `unlockInvoice` also takes (via `claimInvoiceRow`). That isolation is the
// point: for a payment and an unlock on the same invoice (hence the same order) EITHER lock would
// serialize them; holding only the invoice lock makes the competitor's serialization come from
// nothing but its OWN invoice claim, so the test discriminates on exactly that claim.
//
// Verified RED by hand by commenting out the `hasReceivableActivity` guard in `unlockInvoiceInTx`:
// the competitor then acquires the invoice lock after the holder commits, re-reads the invoice as
// still FINALIZED (the holder only added an application, it did not change status), finds no guard,
// and unlocks to DRAFT — both commit, leaving a DRAFT invoice with a live application. Restored →
// GREEN (transcripts in the task report).

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(truncateAll);

let seq = 0;
async function finalized1000(): Promise<{ invoiceId: string; customerId: string }> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `UC${seq}`, name: `Unlock Customer ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 730000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly("2026-08-08"), total: 1000, finalizedAt: new Date(),
    },
  });
  return { invoiceId: invoice.id, customerId: customer.id };
}

async function makePayment(customerId: string, amount: number): Promise<{ id: string }> {
  seq += 1;
  const batch = await prisma.receiptBatch.create({
    data: { batchNumber: 830000 + seq, depositDate: parseDateOnly("2026-08-08") },
  });
  const paymentType = await prisma.paymentType.create({ data: { name: `PT-U-${seq}` } });
  const payment = await prisma.payment.create({
    data: {
      batchId: batch.id, customerId, paymentTypeId: paymentType.id,
      amount, receivedDate: parseDateOnly("2026-08-08"),
    },
  });
  return { id: payment.id };
}

describe("unlockInvoice concurrency — the invoice-row claim serializes an unlock against a racing application", () => {
  it("blocks the competing Read-Committed unlock on the invoice lock; the fresh read then refuses (never both commit)", async () => {
    const { invoiceId, customerId } = await finalized1000();
    const holderPayment = await makePayment(customerId, 700);

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // The holder: DEFAULT (Read Committed) isolation, taking ONLY the invoice-row `FOR UPDATE` claim
    // (deliberately not the order lock — see the file header), writing a 700 PAYMENT application,
    // then holding it uncommitted until released. The write happens BEFORE the signal so the row is
    // genuinely locked and the application genuinely present-but-uncommitted while the competitor runs.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
      await tx.application.create({
        data: {
          invoiceId, amount: 700, type: "PAYMENT", paymentId: holderPayment.id,
          appliedDate: parseDateOnly("2026-08-08"),
        },
      });
      hasClaimed();
      await release;
    }, { timeout: 20000 });

    await claimed;

    // The competitor: `unlockInvoice` on a manually-opened DEFAULT (Read Committed) transaction — NOT
    // the public Serializable path, so SSI is out of the picture and the invoice-row claim is the
    // only thing that can serialize it.
    const competitor = asSystem(() => prisma.$transaction((tx) =>
      unlockInvoice(invoiceId, "reopen to correct", tx)));

    // Not the discriminator — just proof the competitor's own invoice claim is genuinely blocked on
    // the holder before the holder is released. With the guard removed it still blocks here (the
    // claim is intact); the difference shows up in the outcome below.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      competitor.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    // The discriminator: with the invoice row locked, the competitor could decide nothing until the
    // holder's 700 committed. Its fresh Read-Committed read then sees that live application and
    // REFUSES the unlock — deterministically this exact 400, never both committing.
    await expect(competitor).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/has payments applied — void them before unlocking/),
    });

    // The invoice is untouched — still FINALIZED — and the holder's one application is still live.
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true } });
    expect(invoice.status).toBe("FINALIZED");
    const live = await prisma.application.findMany({ where: { invoiceId, deletedAt: null } });
    expect(live).toHaveLength(1);
  });
});
