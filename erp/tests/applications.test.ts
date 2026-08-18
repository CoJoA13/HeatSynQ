import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import {
  applyPayment, voidApplication, discountAvailable, applyCredit,
  invoiceOpenBalanceById, openInvoicesForPayer,
} from "@/server/applications";
import { invoiceOpenBalance, paymentOnAccount, creditRemaining, type ApplicationLite } from "@/server/ar-balances";
import { parseDateOnly } from "@/lib/business-days";
import type { Payment, Terms } from "../prisma/generated/prisma/client";

// Task 7 (P5B §4.1/§4.2): the single cash write path. `applyPayment` settles a payment across one
// or more finalized invoices under ONE sorted claim (orders, then the invoice rows); each line
// records a PAYMENT/DISCOUNT/WRITE_OFF `Application`, and the unapplied remainder is on-account by
// construction (no write). Over-application against the invoice's open balance, over-application
// of the payment, the early-pay discount window, the write-off reason, and void-restores are all
// exercised here; the invoice-row-lock discipline that makes two concurrent applications refuse
// the second is its own file (applications-concurrency.test.ts).

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(truncateAll);

let seq = 0;

async function makeTerms(discountPercent: string | null, discountDays: number | null, netDays = 30): Promise<Terms> {
  seq += 1;
  return prisma.terms.create({
    data: { name: `Terms-${seq}`, netDays, discountPercent, discountDays },
  });
}

type Fixture = { invoiceId: string; orderId: string; orderNumber: number; customerId: string };

async function finalizedInvoice(opts: {
  total: number; invoiceDate?: string; termsId?: string | null; customerId?: string;
}): Promise<Fixture> {
  seq += 1;
  const customerId = opts.customerId ?? (await prisma.customer.create({
    data: { code: `APC${seq}`, name: `AP Customer ${seq}`, termsId: opts.termsId ?? undefined },
  })).id;
  const orderNumber = 500000 + seq;
  const order = await prisma.order.create({
    data: {
      orderNumber, customerId, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  // #79: a finalized invoice carries its ISSUED discount terms, frozen. This fixture writes them
  // directly (it builds the row rather than going through `finalizeInvoice`), so it has to write
  // what finalize writes — otherwise it models an invoice that could not exist.
  const issued = opts.termsId
    ? await prisma.terms.findUniqueOrThrow({
        where: { id: opts.termsId }, select: { discountPercent: true, discountDays: true } })
    : null;
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED",
      orderId: order.id, customerId,
      invoiceDate: parseDateOnly(opts.invoiceDate ?? "2026-08-08"),
      total: opts.total, finalizedAt: new Date(),
      termsDiscountPercent: issued?.discountPercent ?? null,
      termsDiscountDays: issued?.discountDays ?? null,
    },
  });
  return { invoiceId: invoice.id, orderId: order.id, orderNumber, customerId };
}

async function makePayment(customerId: string, amount: number, receivedDate = "2026-08-08"): Promise<Payment> {
  seq += 1;
  const batch = await prisma.receiptBatch.create({
    data: { batchNumber: 900000 + seq, depositDate: parseDateOnly("2026-08-08") },
  });
  const paymentType = await prisma.paymentType.create({ data: { name: `PT-${seq}` } });
  return prisma.payment.create({
    data: {
      batchId: batch.id, customerId, paymentTypeId: paymentType.id,
      amount, receivedDate: parseDateOnly(receivedDate),
    },
  });
}

const toLite = (a: { amount: { toNumber(): number }; type: ApplicationLite["type"]; deletedAt: Date | null }): ApplicationLite =>
  ({ amount: a.amount.toNumber(), type: a.type, deletedAt: a.deletedAt });

async function openBalance(invoiceId: string): Promise<number> {
  const inv = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId }, include: { applications: true },
  });
  return invoiceOpenBalance(inv.total.toNumber(), inv.applications.map(toLite));
}

async function onAccount(paymentId: string): Promise<number> {
  const p = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId }, include: { applications: true },
  });
  return paymentOnAccount(p.amount.toNumber(), p.applications.map(toLite));
}

// Task 8: a finalized CREDIT lives in the same `Invoice` table as an INVOICE (kind discriminates),
// on its OWN order — nothing ties it to the target invoice's order, so a test that puts them on
// different orders is the realistic shape ("apply this job's credit to that job's invoice") and
// exercises the two-order claim for real (same-order would collapse to one claim via dedup).
async function finalizedCredit(opts: { total: number; status?: "DRAFT" | "FINALIZED"; customerId?: string }): Promise<Fixture> {
  seq += 1;
  const customerId = opts.customerId ?? (await prisma.customer.create({
    data: { code: `APCR${seq}`, name: `AP Credit Customer ${seq}` },
  })).id;
  const orderNumber = 550000 + seq;
  const order = await prisma.order.create({
    data: {
      orderNumber, customerId, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const status = opts.status ?? "FINALIZED";
  const credit = await prisma.invoice.create({
    data: {
      kind: "CREDIT", status,
      orderId: order.id, customerId,
      invoiceDate: parseDateOnly("2026-08-08"),
      total: opts.total, finalizedAt: status === "FINALIZED" ? new Date() : null,
    },
  });
  return { invoiceId: credit.id, orderId: order.id, orderNumber, customerId };
}

async function creditOpenRemaining(creditId: string): Promise<number> {
  const c = await prisma.invoice.findUniqueOrThrow({
    where: { id: creditId }, include: { creditApplications: true },
  });
  return creditRemaining(c.total.toNumber(), c.creditApplications.map(toLite));
}

// -------------------------------------------------------------------------------------------
// Step 1: partial payment + open balance, then over-application refusal.
// -------------------------------------------------------------------------------------------

describe("applyPayment — partial payment and open balance", () => {
  it("applies a partial payment; open balance drops, on-account stays zero", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const payment = await makePayment(inv.customerId, 600);

    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }));

    expect(await openBalance(inv.invoiceId)).toBe(400);
    expect(await onAccount(payment.id)).toBe(0);
  });

  it("refuses a payment line that would exceed the invoice's open balance", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const first = await makePayment(inv.customerId, 600);
    await asSystem(() => applyPayment({
      paymentId: first.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }));

    const second = await makePayment(inv.customerId, 600);
    await expect(asSystem(() => applyPayment({
      paymentId: second.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }))).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/exceeds the invoice's open balance of 400/),
    });
    // Nothing from the refused call was written.
    expect(await openBalance(inv.invoiceId)).toBe(400);
    expect(await prisma.application.count({ where: { paymentId: second.id } })).toBe(0);
  });

  it("leaves the unapplied remainder on-account with no write", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const payment = await makePayment(inv.customerId, 600);
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 250 }],
    }));
    expect(await onAccount(payment.id)).toBe(350); // 600 − 250, no on-account row
    expect(await prisma.application.count({ where: { paymentId: payment.id } })).toBe(1);
  });

  it("refuses when the PAYMENT lines exceed the payment's unapplied amount", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const payment = await makePayment(inv.customerId, 500);
    await expect(asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }))).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/unapplied amount of 500/),
    });
  });

  it("settles two invoices from one payment in a single call", async () => {
    const a = await finalizedInvoice({ total: 400 });
    const b = await finalizedInvoice({ total: 700, customerId: a.customerId }); // same payer, two invoices
    const payment = await makePayment(a.customerId, 1000);
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [
        { invoiceId: a.invoiceId, type: "PAYMENT", amount: 400 },
        { invoiceId: b.invoiceId, type: "PAYMENT", amount: 600 },
      ],
    }));
    expect(await openBalance(a.invoiceId)).toBe(0);
    expect(await openBalance(b.invoiceId)).toBe(100);
    expect(await onAccount(payment.id)).toBe(0);
  });

  it("audits a PAYMENT application with real content — amount, type, applied date, and the invoice's order number", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const payment = await makePayment(inv.customerId, 600, "2026-08-05");
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId, type: "PAYMENT" } });
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "application", entityId: app.id, action: "create" },
    });
    expect(entry).not.toBeNull();
    const after = entry!.after as Record<string, unknown>;
    expect(after.amount).toBe(600);
    expect(after.type).toBe("PAYMENT");
    expect(after.invoiceId).toBe(inv.invoiceId);
    expect(after.paymentId).toBe(payment.id);
    expect(after.appliedDate).toBe("2026-08-05"); // = payment.receivedDate
    expect(after.invoiceOrderNumber).toBe(inv.orderNumber);
  });
});

// -------------------------------------------------------------------------------------------
// Step 3: target validation — only a live FINALIZED INVOICE can take a payment.
// -------------------------------------------------------------------------------------------

describe("applyPayment — target validation", () => {
  it("404s a missing invoice", async () => {
    const inv = await finalizedInvoice({ total: 100 });
    const payment = await makePayment(inv.customerId, 100);
    await expect(asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: "nope", type: "PAYMENT", amount: 10 }],
    }))).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a DRAFT invoice", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    await prisma.invoice.update({ where: { id: inv.invoiceId }, data: { status: "DRAFT" } });
    const payment = await makePayment(inv.customerId, 100);
    await expect(asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 100 }],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/finalized/i) });
  });

  it("refuses a CREDIT memo as a payment target", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    await prisma.invoice.update({ where: { id: inv.invoiceId }, data: { kind: "CREDIT" } });
    const payment = await makePayment(inv.customerId, 100);
    await expect(asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 100 }],
    }))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/credit/i) });
  });
});

// -------------------------------------------------------------------------------------------
// FIX (Codex): a payment settles only its own customer's family (§4.1) — an unrelated customer's
// invoice must be refused; a sibling division's invoice in the SAME family is allowed (the
// spec-permitted cross-division case).
// -------------------------------------------------------------------------------------------

describe("applyPayment — family scoping", () => {
  it("refuses a payment line targeting an unrelated customer's invoice", async () => {
    const payerInv = await finalizedInvoice({ total: 1000 });
    const strangerInv = await finalizedInvoice({ total: 1000 }); // a different, unrelated customer
    const payment = await makePayment(payerInv.customerId, 1000);
    await expect(asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: strangerInv.invoiceId, type: "PAYMENT", amount: 100 }],
    }))).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/outside this payment's family/),
    });
    expect(await prisma.application.count({ where: { invoiceId: strangerInv.invoiceId } })).toBe(0);
  });

  it("allows a payment to settle a sibling division's invoice in the same family", async () => {
    seq += 1;
    const parent = await prisma.customer.create({ data: { code: `FAMP${seq}`, name: `Fam Parent ${seq}` } });
    const childA = await prisma.customer.create({ data: { code: `FAMA${seq}`, name: `Fam Child A ${seq}`, parentId: parent.id } });
    const childB = await prisma.customer.create({ data: { code: `FAMB${seq}`, name: `Fam Child B ${seq}`, parentId: parent.id } });
    // The invoice belongs to childB; the payment is childA's — same family (shared parent).
    const sibInv = await finalizedInvoice({ total: 500, customerId: childB.id });
    const payment = await makePayment(childA.id, 500);
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: sibInv.invoiceId, type: "PAYMENT", amount: 300 }],
    }));
    expect(await openBalance(sibInv.invoiceId)).toBe(200);
  });
});

// -------------------------------------------------------------------------------------------
// Step 5: the early-pay discount window.
// -------------------------------------------------------------------------------------------

describe("discountAvailable — the early-pay window", () => {
  it("returns discountPercent × the invoice open balance inside the window", async () => {
    const terms = await makeTerms("2.00", 10); // 2/10 Net 30
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(20); // 2% × 1000
  });

  it("returns 0 once the window has closed", async () => {
    const terms = await makeTerms("2.00", 10);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-28"); // invoiceDate + 20 days
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(0);
  });

  it("returns 0 when the terms carry no discount", async () => {
    const terms = await makeTerms(null, null);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(0);
  });

  it("is inclusive of the last day of the window", async () => {
    const terms = await makeTerms("2.00", 10);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-18"); // invoiceDate + 10 days exactly
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(20);
  });

  // #79. The discount read the invoice CUSTOMER's current terms relation, so reassigning a customer
  // rewrote what invoices already in their hands were worth — in BOTH directions. An invoice is
  // frozen paper (§5.4): it now carries the numbers behind its own `termsName`.
  it("keeps the discount its ISSUED terms offered when the customer is moved off them (#79)", async () => {
    const issued = await makeTerms("2.00", 10); // 2/10 Net 30 on the day it was sent
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: issued.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(20);

    // The customer is moved to plain Net 30 AFTER the paper went out.
    const now = await makeTerms(null, null);
    await prisma.customer.update({ where: { id: inv.customerId }, data: { termsId: now.id } });

    // Before the fix this collapsed to 0 — a discount the customer had been promised in writing.
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(20);
  });

  it("does not GRANT a discount the paper never offered (#79, the other direction)", async () => {
    const issued = await makeTerms(null, null); // plain Net 30 on the day it was sent
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: issued.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(0);

    const now = await makeTerms("2.00", 10);
    await prisma.customer.update({ where: { id: inv.customerId }, data: { termsId: now.id } });

    // Before the fix this became 20 — money off an invoice that never offered any.
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(0);
  });

  it("refuses to APPLY a discount the issued terms never offered, not just to display none (#79)", async () => {
    // The guard that matters: `discountAvailable` feeds the UI, but `applyPayment` caps the DISCOUNT
    // line independently. Both must read the frozen pair or the save would still let one through.
    const issued = await makeTerms(null, null);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: issued.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");
    const now = await makeTerms("2.00", 10);
    await prisma.customer.update({ where: { id: inv.customerId }, data: { termsId: now.id } });

    await expect(asSystem(() => applyPayment({
      paymentId: payment.id,
      lines: [{ invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 20 }],
    // Pinned to the exact refusal: several other messages in `resolveReason` also say "discount",
    // so a loose /discount/i could pass through the wrong branch entirely.
    }))).rejects.toThrow(/no early-pay discount applies/i);
  });
});

// -------------------------------------------------------------------------------------------
// Task 13 reads: invoiceOpenBalanceById + openInvoicesForPayer. Not part of Task 7's original
// surface — added for the batch-apply screen, which needs a per-invoice open balance and a
// pickable list of a payer's (and its family's) open invoices, neither of which any existing
// route surfaces (see the file-header comment above `openInvoicesForPayer`).
// -------------------------------------------------------------------------------------------

describe("invoiceOpenBalanceById", () => {
  it("returns the full total for a fresh invoice and the reduced balance after a payment", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    expect(await asSystem(() => invoiceOpenBalanceById(inv.invoiceId))).toBe(1000);
    const payment = await makePayment(inv.customerId, 600);
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }));
    expect(await asSystem(() => invoiceOpenBalanceById(inv.invoiceId))).toBe(400);
  });

  it("404s a missing invoice", async () => {
    await expect(asSystem(() => invoiceOpenBalanceById("nope"))).rejects.toMatchObject({ status: 404 });
  });
});

describe("openInvoicesForPayer", () => {
  it("lists a standalone payer's own open finalized invoices only", async () => {
    const invA = await finalizedInvoice({ total: 1000 });
    const invB = await finalizedInvoice({ total: 500 }); // different customer — must not leak in
    const rows = await asSystem(() => openInvoicesForPayer(invA.customerId));
    expect(rows.map((r) => r.id)).toEqual([invA.invoiceId]);
    expect(rows.map((r) => r.id)).not.toContain(invB.invoiceId);
    expect(rows[0].open).toBe(1000);
    expect(rows[0].total).toBe(1000);
  });

  it("excludes a fully-settled invoice and a CREDIT-kind document", async () => {
    const inv = await finalizedInvoice({ total: 300 });
    const payment = await makePayment(inv.customerId, 300);
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 300 }],
    }));
    seq += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: 501000 + seq, customerId: inv.customerId, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
      },
    });
    await prisma.invoice.create({
      data: {
        kind: "CREDIT", status: "FINALIZED", orderId: order.id, customerId: inv.customerId,
        invoiceDate: parseDateOnly("2026-08-08"), total: -100, finalizedAt: new Date(),
      },
    });
    expect(await asSystem(() => openInvoicesForPayer(inv.customerId))).toEqual([]);
  });

  it("rolls up a PARENT payer's own invoices plus its children's", async () => {
    seq += 1;
    const parent = await prisma.customer.create({ data: { code: `APP${seq}`, name: `Parent ${seq}` } });
    const child = await prisma.customer.create({ data: { code: `APCH${seq}`, name: `Child ${seq}`, parentId: parent.id } });
    async function invoiceFor(customerId: string, total: number) {
      seq += 1;
      const order = await prisma.order.create({
        data: {
          orderNumber: 502000 + seq, customerId, status: "SHIPPED",
          receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
        },
      });
      return prisma.invoice.create({
        data: {
          kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId,
          invoiceDate: parseDateOnly("2026-08-08"), total, finalizedAt: new Date(),
        },
      });
    }
    const parentInv = await invoiceFor(parent.id, 100);
    const childInv = await invoiceFor(child.id, 200);
    const rows = await asSystem(() => openInvoicesForPayer(parent.id));
    expect(rows.map((r) => r.id).sort()).toEqual([parentInv.id, childInv.id].sort());
  });

  it("404s a missing customer", async () => {
    await expect(asSystem(() => openInvoicesForPayer("nope"))).rejects.toMatchObject({ status: 404 });
  });
});

describe("applyPayment — DISCOUNT line", () => {
  it("refuses a DISCOUNT line outside the window", async () => {
    const terms = await makeTerms("2.00", 10);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-28");
    await expect(asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 20 }],
    }))).rejects.toMatchObject({ status: 400, message: "no early-pay discount applies" });
  });

  it("applies a DISCOUNT inside the window and stamps reason 'early-pay terms'", async () => {
    const terms = await makeTerms("2.00", 10);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 980, "2026-08-08");
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [
        { invoiceId: inv.invoiceId, type: "PAYMENT", amount: 980 },
        { invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 20 },
      ],
    }));
    expect(await openBalance(inv.invoiceId)).toBe(0); // 980 paid + 20 discounted
    const disc = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId, type: "DISCOUNT" } });
    expect(disc.reason).toBe("early-pay terms");
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "application", entityId: disc.id, action: "create" },
    });
    expect((entry!.after as Record<string, unknown>).reason).toBe("early-pay terms");
  });

  // FIX (Codex): the early-pay window opening does NOT license waiving the whole receivable as a
  // "discount" — a DISCOUNT line is capped at discountPercent × the open balance.
  it("refuses a DISCOUNT line greater than the eligible early-pay amount, naming it", async () => {
    const terms = await makeTerms("2.00", 10); // 2/10 → eligible 20 on a 1000 invoice
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");
    await expect(asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 1000 }],
    }))).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/discount exceeds the eligible early-pay amount of 20/),
    });
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId } })).toBe(0);
  });

  it("allows a DISCOUNT line equal to the eligible early-pay amount", async () => {
    const terms = await makeTerms("2.00", 10);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 20 }],
    }));
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId, type: "DISCOUNT" } })).toBe(1);
    expect(await openBalance(inv.invoiceId)).toBe(980);
  });

  /**
   * #81 (P1) — the cap was PER LINE, not aggregate.
   *
   * `APPLY.lines` permits repeated lines against the same invoice, and `resolveReason` derived
   * eligibility only from applications persisted BEFORE the call — so `elig` was recomputed
   * identically for every line in one request. Fifty $20 lines each passed the $20 per-line check,
   * the running open-balance guard permitted the $1,000 aggregate, and the entire receivable was
   * waived as an "early-pay discount". The per-line cap that closed the single-line case
   * (`bb40d66`) is what made this look guarded.
   */
  it("refuses repeated DISCOUNT lines that together exceed the eligible amount — the fifty-line waiver", async () => {
    const terms = await makeTerms("2.00", 10); // 2/10 → eligible 20 on a 1000 invoice
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");

    await expect(asSystem(() => applyPayment({
      paymentId: payment.id,
      lines: Array.from({ length: 50 }, () => ({
        invoiceId: inv.invoiceId, type: "DISCOUNT" as const, amount: 20,
      })),
    }))).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/discount exceeds the eligible early-pay amount of 20/),
    });

    // The whole call rolls back — not "the first eligible 20 landed and the rest were refused".
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId } })).toBe(0);
    expect(await openBalance(inv.invoiceId)).toBe(1000);
  });

  it("refuses a SECOND discount line that tips a legal first one over the cap", async () => {
    const terms = await makeTerms("2.00", 10);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");

    // 15 + 10 = 25 > 20. Each line alone would pass the per-line check.
    await expect(asSystem(() => applyPayment({
      paymentId: payment.id,
      lines: [
        { invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 15 },
        { invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 10 },
      ],
    }))).rejects.toMatchObject({ status: 400 });
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId } })).toBe(0);
  });

  it("still allows split discount lines that together stay within the cap", async () => {
    const terms = await makeTerms("2.00", 10);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");

    // The aggregate cap must not become "one discount line per invoice" — 12 + 8 = 20 is legal.
    await asSystem(() => applyPayment({
      paymentId: payment.id,
      lines: [
        { invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 12 },
        { invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 8 },
      ],
    }));
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId, type: "DISCOUNT" } })).toBe(2);
    expect(await openBalance(inv.invoiceId)).toBe(980);
  });

  /**
   * The CROSS-REQUEST half of the cap (#81, raised independently by Codex on PR #129).
   *
   * The in-request tally alone did nothing here, because every call started its tally at zero and
   * `discountFor` is a percentage of the CURRENT open balance — which a discount reduces. So a
   * second call was offered a fresh, only slightly smaller entitlement: $20, then $19.60 of the
   * remaining $980, then $19.21… converging on the whole receivable. Measured before the fix: the
   * second call took its $19.60 and the invoice sat at $960.40 on a nominal 2% entitlement.
   *
   * The ceiling is now a percentage of the STABLE invoice total minus the discount already taken,
   * floored against the current per-call offer — the tighter of the two, never the looser, so no
   * terms-policy question is decided (see `remainingDiscountFor`).
   */
  it("refuses a SECOND discount request once the entitlement is spent — the creep is closed", async () => {
    const terms = await makeTerms("2.00", 10);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");

    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 20 }],
    }));
    expect(await openBalance(inv.invoiceId)).toBe(980);

    // The entitlement is spent, so the UI is offered nothing — it must never show an amount the
    // save would refuse.
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(0);

    await expect(asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 19.6 }],
    }))).rejects.toMatchObject({ status: 400, message: "no early-pay discount applies" });
    expect(await openBalance(inv.invoiceId)).toBe(980); // unmoved
  });

  it("still allows the entitlement to be taken in two separate requests, up to the cap", async () => {
    const terms = await makeTerms("2.00", 10);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");

    // The cap is on the TOTAL, not "one discount per invoice" — 12 now and 8 later is legal.
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 12 }],
    }));
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(8);
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 8 }],
    }));
    expect(await openBalance(inv.invoiceId)).toBe(980);
  });

  /**
   * The ceiling must never be LOOSER than the per-call offer, or closing the creep would quietly
   * widen the partial-payment case: on a half-paid $1,000 invoice today's rule offers 2% of the
   * $500 remaining, while the entitlement rule alone would allow the full $20. The minimum keeps
   * today's answer.
   */
  it("keeps the per-call offer when it is the smaller of the two — no policy widening", async () => {
    const terms = await makeTerms("2.00", 10);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");

    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 500 }],
    }));
    // 2% of the remaining 500 = 10, which is BELOW the 20 entitlement — so 10 is the answer.
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(10);
    await expect(asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 20 }],
    }))).rejects.toMatchObject({ status: 400 });
  });

  /** A VOIDED discount frees its entitlement again — the same "voided counts for nothing" rule
   *  every ar-balances sum applies, so a mis-keyed discount can be corrected and re-taken. */
  it("restores the entitlement when a discount is voided", async () => {
    const terms = await makeTerms("2.00", 10);
    const inv = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    const payment = await makePayment(inv.customerId, 1000, "2026-08-08");
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "DISCOUNT", amount: 20 }],
    }));
    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(0);

    const app = await prisma.application.findFirstOrThrow({
      where: { invoiceId: inv.invoiceId, type: "DISCOUNT", deletedAt: null } });
    await asSystem(() => voidApplication(app.id, "keyed the wrong discount"));

    expect(await asSystem(() => discountAvailable(payment.id, inv.invoiceId))).toBe(20);
  });

  it("caps each invoice on its own — one invoice's discount does not consume another's", async () => {
    const terms = await makeTerms("2.00", 10);
    const a = await finalizedInvoice({ total: 1000, invoiceDate: "2026-08-08", termsId: terms.id });
    // Same customer, so one payment can settle both and the running maps are keyed per invoice.
    const b = await finalizedInvoice({
      total: 1000, invoiceDate: "2026-08-08", termsId: terms.id, customerId: a.customerId });
    const payment = await makePayment(a.customerId, 2000, "2026-08-08");

    await asSystem(() => applyPayment({
      paymentId: payment.id,
      lines: [
        { invoiceId: a.invoiceId, type: "DISCOUNT", amount: 20 },
        { invoiceId: b.invoiceId, type: "DISCOUNT", amount: 20 },
      ],
    }));
    expect(await openBalance(a.invoiceId)).toBe(980);
    expect(await openBalance(b.invoiceId)).toBe(980);
  });
});

// -------------------------------------------------------------------------------------------
// Step 8: a write-off needs a reason; the reason is stored and audited.
// -------------------------------------------------------------------------------------------

describe("applyPayment — WRITE_OFF line", () => {
  it("refuses a WRITE_OFF with no reason", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const payment = await makePayment(inv.customerId, 1000);
    await expect(asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "WRITE_OFF", amount: 100 }],
    }))).rejects.toMatchObject({ status: 400, message: "a write-off needs a reason" });
    expect(await prisma.application.count()).toBe(0);
  });

  it("refuses a WRITE_OFF whose reason is only whitespace", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const payment = await makePayment(inv.customerId, 1000);
    await expect(asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "WRITE_OFF", amount: 100, reason: "   " }],
    }))).rejects.toMatchObject({ status: 400, message: "a write-off needs a reason" });
  });

  it("reduces the open balance and records the reason on the application and the audit entry", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const payment = await makePayment(inv.customerId, 1000);
    await asSystem(() => applyPayment({
      paymentId: payment.id,
      lines: [{ invoiceId: inv.invoiceId, type: "WRITE_OFF", amount: 100, reason: "  uncollectable remainder  " }],
    }));
    expect(await openBalance(inv.invoiceId)).toBe(900);
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId, type: "WRITE_OFF" } });
    expect(app.reason).toBe("uncollectable remainder"); // trimmed
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "application", entityId: app.id, action: "create" },
    });
    const after = entry!.after as Record<string, unknown>;
    expect(after.reason).toBe("uncollectable remainder");
    expect(after.type).toBe("WRITE_OFF");
    expect(after.amount).toBe(100);
  });
});

// -------------------------------------------------------------------------------------------
// Step 10: void restores the invoice open balance and the payment on-account.
// -------------------------------------------------------------------------------------------

describe("voidApplication — restores balances", () => {
  it("restores the invoice open balance and the payment on-account", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const payment = await makePayment(inv.customerId, 600);
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });
    expect(await openBalance(inv.invoiceId)).toBe(400);
    expect(await onAccount(payment.id)).toBe(0);

    await asSystem(() => voidApplication(app.id, "misapplied to the wrong invoice"));

    expect(await openBalance(inv.invoiceId)).toBe(1000);
    expect(await onAccount(payment.id)).toBe(600);
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "application", entityId: app.id, action: "delete" },
    });
    expect(entry!.reason).toBe("misapplied to the wrong invoice");
  });

  it("requires a non-blank reason to void", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const payment = await makePayment(inv.customerId, 600);
    await asSystem(() => applyPayment({
      paymentId: payment.id, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });
    await expect(asSystem(() => voidApplication(app.id, "   "))).rejects.toThrow(/reason/i);
    expect(await openBalance(inv.invoiceId)).toBe(400); // untouched
  });

  it("404s a missing or already-voided application", async () => {
    await expect(asSystem(() => voidApplication("nope", "x"))).rejects.toMatchObject({ status: 404 });
  });
});

// -------------------------------------------------------------------------------------------
// Task 8: applyCredit — a finalized CREDIT memo applied to a finalized INVOICE, both balances
// (the invoice's open balance AND the credit's own remaining) guarded under one claim.
// -------------------------------------------------------------------------------------------

describe("applyCredit — both balances guarded", () => {
  it("applies a credit; invoice open drops and credit remaining drops together", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const credit = await finalizedCredit({ total: -500, customerId: inv.customerId }); // remaining 500
    expect(await creditOpenRemaining(credit.invoiceId)).toBe(500);

    await asSystem(() => applyCredit({
      creditInvoiceId: credit.invoiceId, invoiceId: inv.invoiceId, amount: 300,
    }));

    expect(await openBalance(inv.invoiceId)).toBe(700);
    expect(await creditOpenRemaining(credit.invoiceId)).toBe(200);
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId, type: "CREDIT" } });
    expect(app.creditInvoiceId).toBe(credit.invoiceId);
    expect(app.paymentId).toBeNull();
  });

  it("refuses an application that would exceed the credit's remaining", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const credit = await finalizedCredit({ total: -500, customerId: inv.customerId }); // remaining 500
    await asSystem(() => applyCredit({
      creditInvoiceId: credit.invoiceId, invoiceId: inv.invoiceId, amount: 300,
    })); // remaining now 200

    await expect(asSystem(() => applyCredit({
      creditInvoiceId: credit.invoiceId, invoiceId: inv.invoiceId, amount: 250,
    }))).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/exceeds the credit's remaining of 200/),
    });
    // Nothing from the refused call was written.
    expect(await creditOpenRemaining(credit.invoiceId)).toBe(200);
    expect(await openBalance(inv.invoiceId)).toBe(700);
  });

  it("refuses an application that would exceed the invoice's open balance, even with plenty of credit left", async () => {
    const inv = await finalizedInvoice({ total: 100 }); // open only 100
    const credit = await finalizedCredit({ total: -1000, customerId: inv.customerId }); // remaining 1000, plenty

    await expect(asSystem(() => applyCredit({
      creditInvoiceId: credit.invoiceId, invoiceId: inv.invoiceId, amount: 200,
    }))).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/exceeds the invoice's open balance of 100/),
    });
    expect(await creditOpenRemaining(credit.invoiceId)).toBe(1000); // untouched
    expect(await openBalance(inv.invoiceId)).toBe(100); // untouched
  });

  it("refuses a DRAFT credit source", async () => {
    const credit = await finalizedCredit({ total: -500, status: "DRAFT" });
    const inv = await finalizedInvoice({ total: 1000 });

    await expect(asSystem(() => applyCredit({
      creditInvoiceId: credit.invoiceId, invoiceId: inv.invoiceId, amount: 100,
    }))).rejects.toMatchObject({
      status: 400,
      message: "only a finalized credit can be applied",
    });
    expect(await prisma.application.count()).toBe(0);
  });

  it("refuses a plain INVOICE as the credit source", async () => {
    const notACredit = await finalizedInvoice({ total: 500 });
    const inv = await finalizedInvoice({ total: 1000 });
    await expect(asSystem(() => applyCredit({
      creditInvoiceId: notACredit.invoiceId, invoiceId: inv.invoiceId, amount: 100,
    }))).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a CREDIT as the application target", async () => {
    const credit = await finalizedCredit({ total: -500 });
    const alsoACredit = await finalizedCredit({ total: -900 });
    await expect(asSystem(() => applyCredit({
      creditInvoiceId: credit.invoiceId, invoiceId: alsoACredit.invoiceId, amount: 100,
    }))).rejects.toMatchObject({ status: 400 });
  });

  it("404s a missing credit or missing target invoice", async () => {
    const credit = await finalizedCredit({ total: -500 });
    const inv = await finalizedInvoice({ total: 1000 });
    await expect(asSystem(() => applyCredit({
      creditInvoiceId: "nope", invoiceId: inv.invoiceId, amount: 100,
    }))).rejects.toMatchObject({ status: 404 });
    await expect(asSystem(() => applyCredit({
      creditInvoiceId: credit.invoiceId, invoiceId: "nope", amount: 100,
    }))).rejects.toMatchObject({ status: 404 });
  });

  it("audits a CREDIT application with real content — type, amount, both FKs, and today's applied date", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const credit = await finalizedCredit({ total: -500, customerId: inv.customerId });
    await asSystem(() => applyCredit({
      creditInvoiceId: credit.invoiceId, invoiceId: inv.invoiceId, amount: 300,
    }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId, type: "CREDIT" } });
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "application", entityId: app.id, action: "create" },
    });
    expect(entry).not.toBeNull();
    const after = entry!.after as Record<string, unknown>;
    expect(after.type).toBe("CREDIT");
    expect(after.amount).toBe(300);
    expect(after.invoiceId).toBe(inv.invoiceId);
    expect(after.creditInvoiceId).toBe(credit.invoiceId);
    expect(after.paymentId).toBeNull();
    expect(typeof after.appliedDate).toBe("string"); // formatted "YYYY-MM-DD", not an ISO timestamp
  });

  it("voiding a CREDIT application snapshots its source credit's order number, not a bare cuid (audit.ts SNAPSHOT_INCLUDE carry)", async () => {
    const inv = await finalizedInvoice({ total: 1000 });
    const credit = await finalizedCredit({ total: -500, customerId: inv.customerId });
    await asSystem(() => applyCredit({
      creditInvoiceId: credit.invoiceId, invoiceId: inv.invoiceId, amount: 300,
    }));
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId, type: "CREDIT" } });

    await asSystem(() => voidApplication(app.id, "issued in error"));

    const entry = await prisma.auditLog.findFirst({
      where: { entity: "application", entityId: app.id, action: "delete" },
    });
    expect(entry).not.toBeNull();
    const before = entry!.before as Record<string, unknown>;
    const snapshotCredit = before.creditInvoice as Record<string, unknown> | null;
    expect(snapshotCredit).not.toBeNull();
    expect(snapshotCredit!.kind).toBe("CREDIT");
    expect((snapshotCredit!.order as Record<string, unknown>).orderNumber).toBe(credit.orderNumber);
  });

  // FIX (Codex): a credit applies only within its OWN customer's family — an unrelated customer's
  // invoice is refused; a sibling division's invoice in the SAME family is allowed.
  it("refuses a credit applied to an unrelated customer's invoice", async () => {
    const credit = await finalizedCredit({ total: -500 });
    const strangerInv = await finalizedInvoice({ total: 1000 }); // a different, unrelated customer
    await expect(asSystem(() => applyCredit({
      creditInvoiceId: credit.invoiceId, invoiceId: strangerInv.invoiceId, amount: 100,
    }))).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/outside this credit's family/),
    });
    expect(await prisma.application.count()).toBe(0);
  });

  it("allows a credit applied to a sibling division's invoice in the same family", async () => {
    seq += 1;
    const parent = await prisma.customer.create({ data: { code: `CFAMP${seq}`, name: `Credit Fam Parent ${seq}` } });
    const childA = await prisma.customer.create({ data: { code: `CFAMA${seq}`, name: `Credit Fam Child A ${seq}`, parentId: parent.id } });
    const childB = await prisma.customer.create({ data: { code: `CFAMB${seq}`, name: `Credit Fam Child B ${seq}`, parentId: parent.id } });
    // The credit belongs to childA; the target invoice to childB — same family (shared parent).
    const credit = await finalizedCredit({ total: -500, customerId: childA.id });
    const sibInv = await finalizedInvoice({ total: 1000, customerId: childB.id });
    await asSystem(() => applyCredit({
      creditInvoiceId: credit.invoiceId, invoiceId: sibInv.invoiceId, amount: 300,
    }));
    expect(await openBalance(sibInv.invoiceId)).toBe(700);
    expect(await creditOpenRemaining(credit.invoiceId)).toBe(200);
  });
});
