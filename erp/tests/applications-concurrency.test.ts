import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { applyPayment, familyCustomerIds } from "@/server/applications";
import { parseDateOnly } from "@/lib/business-days";

// Phase 5B's FIRST concurrency test (task brief Step 12). Two applications race on ONE finalized
// 1000 invoice, 700 each; the second must see the first's committed Application row and refuse,
// never both committing to 1400.
//
// The discipline (global-constraints.md / the certs.ts void-vs-mutate precedent): a passing
// concurrency test proves nothing on its own. Two Serializable transactions are ordered by
// Postgres's own SSI whether or not the row lock exists, so a green run under two Serializable
// callers would prove SSI, not `applyPayment`'s invoice-row `FOR UPDATE` claim. So SSI is taken
// off the table entirely — the COMPETING caller runs at DEFAULT (Read Committed) isolation, where
// there is no whole-transaction snapshot and the ONLY thing that can serialize it against the
// holder is a genuine row lock.
//
// The holder is HAND-SCRIPTED to hold PRECISELY the lock under test — the invoice row's `FOR
// UPDATE` — and deliberately NOT the order lock `applyPayment` also takes. That isolation is the
// whole point: `applyPayment` claims the orders behind the invoices AND the invoice rows, and for
// two applications to the SAME invoice (hence the same order) EITHER lock would serialize them. If
// the holder also held the order lock, removing the invoice claim would leave the order lock doing
// the work and the test would stay green — proving nothing about the invoice claim. Holding only
// the invoice lock makes the competitor's serialization come from nothing but its OWN invoice
// claim, so the test discriminates on exactly that claim (the certs void-test technique: script the
// holder to take precisely the row being discriminated on).
//
// Verified RED by hand by commenting out the invoice-row `FOR UPDATE` claim in
// `applyPaymentInTx`: the competitor's fresh Read-Committed read then sees zero committed
// applications, applies its own 700, and both commit to 1400. Restored → GREEN (transcripts in the
// task report).

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(truncateAll);

let seq = 0;
async function finalized1000(): Promise<{ invoiceId: string }> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `CC${seq}`, name: `Concurrency Customer ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 700000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly("2026-08-08"), total: 1000, finalizedAt: new Date(),
    },
  });
  return { invoiceId: invoice.id };
}

async function makePayment(customerId: string, amount: number): Promise<{ id: string }> {
  seq += 1;
  const batch = await prisma.receiptBatch.create({
    data: { batchNumber: 800000 + seq, depositDate: parseDateOnly("2026-08-08") },
  });
  const paymentType = await prisma.paymentType.create({ data: { name: `PT-${seq}` } });
  const payment = await prisma.payment.create({
    data: {
      batchId: batch.id, customerId, paymentTypeId: paymentType.id,
      amount, receivedDate: parseDateOnly("2026-08-08"),
    },
  });
  return { id: payment.id };
}

describe("applyPayment concurrency — the invoice-row claim serializes two applications on one invoice", () => {
  it("blocks a competing Read-Committed application on the invoice lock; the fresh read then refuses (not 1400)", async () => {
    const { invoiceId } = await finalized1000();
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { customerId: true } });
    const holderPayment = await makePayment(invoice.customerId, 700);
    const competitorPayment = await makePayment(invoice.customerId, 700);

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // The holder: DEFAULT (Read Committed) isolation, taking ONLY the invoice-row `FOR UPDATE`
    // claim (deliberately not the order lock — see the file header), writing a 700 PAYMENT
    // application, then holding it uncommitted until released. The write happens BEFORE the signal
    // so the row is genuinely locked and the application genuinely present-but-uncommitted while
    // the competitor runs.
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

    // The competitor: `applyPayment` on a manually-opened DEFAULT (Read Committed) transaction —
    // NOT the public Serializable API, so SSI is out of the picture and the invoice-row claim is
    // the only thing that can serialize it.
    const competitor = asSystem(() => prisma.$transaction((tx) =>
      applyPayment({ paymentId: competitorPayment.id, lines: [{ invoiceId, type: "PAYMENT", amount: 700 }] }, tx)));

    // Not the discriminator — just proof the competitor's own invoice claim is genuinely blocked on
    // the holder before the holder is released. In the regression (claim removed) it never blocks:
    // it reads zero committed applications and settles almost immediately, so THIS assertion fails
    // first.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      competitor.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    // The discriminator: with the invoice row locked, the competitor could decide nothing until the
    // holder's 700 committed. Its fresh Read-Committed read then sees that 700 (open balance 300)
    // and refuses its own 700 — deterministically this exact 400, never both to 1400.
    await expect(competitor).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/exceeds the invoice's open balance of 300/),
    });

    const live = await prisma.application.findMany({ where: { invoiceId, deletedAt: null } });
    expect(live).toHaveLength(1); // only the holder's 700 — the competitor wrote nothing
    expect(live.reduce((s, a) => s + a.amount.toNumber(), 0)).toBe(700);
  });
});

describe("familyCustomerIds runs on the caller's transaction (#215, the #60 class)", () => {
  // applyPaymentInTx and applyCreditInTx call familyCustomerIds from INSIDE their open
  // Serializable transactions. On the top-level prisma singleton that read executes on a SECOND
  // connection — outside the transaction's snapshot AND outside its SSI read-set (a concurrent
  // family edit is invisible: no 40001, no retry), while holding the transaction's pooled
  // connection to acquire another (the P2024 starvation shape close-periods.ts fixed). The
  // deterministic pin, per CLAUDE.md's #60 rule: a row written inside the caller's transaction
  // is visible to the read only if the read genuinely runs on that transaction.
  it("sees a family row written inside the caller's open transaction", async () => {
    const parent = await prisma.customer.create({ data: { code: "FAMP", name: "Family Parent" } });
    const inTx = await prisma.$transaction(async (tx) => {
      const child = await tx.customer.create({
        data: { code: "FAMC", name: "Family Child", parentId: parent.id },
      });
      return { childId: child.id, family: await familyCustomerIds(parent.id, tx) };
    });
    expect(inTx.family).toContain(inTx.childId);
  });

  it("keeps answering on the singleton for the un-transactional callers", async () => {
    const parent = await prisma.customer.create({ data: { code: "FAMQ", name: "Family Q" } });
    const child = await prisma.customer.create({
      data: { code: "FAMR", name: "Family R", parentId: parent.id },
    });
    expect(await familyCustomerIds(parent.id)).toEqual(expect.arrayContaining([parent.id, child.id]));
  });
});
