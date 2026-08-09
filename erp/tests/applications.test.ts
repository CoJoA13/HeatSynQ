import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { applyPayment, voidApplication, discountAvailable, applyCredit } from "@/server/applications";
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
  total: number; invoiceDate?: string; termsId?: string | null;
}): Promise<Fixture> {
  seq += 1;
  const customer = await prisma.customer.create({
    data: { code: `APC${seq}`, name: `AP Customer ${seq}`, termsId: opts.termsId ?? undefined },
  });
  const orderNumber = 500000 + seq;
  const order = await prisma.order.create({
    data: {
      orderNumber, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED",
      orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly(opts.invoiceDate ?? "2026-08-08"),
      total: opts.total, finalizedAt: new Date(),
    },
  });
  return { invoiceId: invoice.id, orderId: order.id, orderNumber, customerId: customer.id };
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
async function finalizedCredit(opts: { total: number; status?: "DRAFT" | "FINALIZED" }): Promise<Fixture> {
  seq += 1;
  const customer = await prisma.customer.create({
    data: { code: `APCR${seq}`, name: `AP Credit Customer ${seq}` },
  });
  const orderNumber = 550000 + seq;
  const order = await prisma.order.create({
    data: {
      orderNumber, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const status = opts.status ?? "FINALIZED";
  const credit = await prisma.invoice.create({
    data: {
      kind: "CREDIT", status,
      orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly("2026-08-08"),
      total: opts.total, finalizedAt: status === "FINALIZED" ? new Date() : null,
    },
  });
  return { invoiceId: credit.id, orderId: order.id, orderNumber, customerId: customer.id };
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
    const b = await finalizedInvoice({ total: 700 });
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
    const credit = await finalizedCredit({ total: -500 }); // remaining 500
    const inv = await finalizedInvoice({ total: 1000 });
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
    const credit = await finalizedCredit({ total: -500 }); // remaining 500
    const inv = await finalizedInvoice({ total: 1000 });
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
    const credit = await finalizedCredit({ total: -1000 }); // remaining 1000, plenty
    const inv = await finalizedInvoice({ total: 100 }); // open only 100

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
    const credit = await finalizedCredit({ total: -500 });
    const inv = await finalizedInvoice({ total: 1000 });
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
    const credit = await finalizedCredit({ total: -500 });
    const inv = await finalizedInvoice({ total: 1000 });
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
});
