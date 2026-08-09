import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { parseDateOnly } from "@/lib/business-days";

import { GET as discountRoute, POST as applyRoute } from "@/app/api/receivables/applications/route";
import { DELETE as voidRoute } from "@/app/api/receivables/applications/[id]/route";
import { POST as applyCreditRoute } from "@/app/api/receivables/credit-applications/route";

const noParams = { params: Promise.resolve({}) };
const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function bodyReq(url: string, method: string, cookie: string | undefined, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

beforeEach(truncateAll);

let seq = 0;
async function finalizedInvoice(total: number): Promise<{ invoiceId: string; customerId: string }> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `ARC${seq}`, name: `AR Route Customer ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 600000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly("2026-08-08"), total, finalizedAt: new Date(),
    },
  });
  return { invoiceId: invoice.id, customerId: customer.id };
}
async function finalizedCredit(total: number): Promise<{ invoiceId: string; customerId: string }> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `ARCR${seq}`, name: `AR Credit Route Customer ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 630000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const credit = await prisma.invoice.create({
    data: {
      kind: "CREDIT", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly("2026-08-08"), total, finalizedAt: new Date(),
    },
  });
  return { invoiceId: credit.id, customerId: customer.id };
}
async function makePayment(customerId: string, amount: number): Promise<string> {
  seq += 1;
  const batch = await prisma.receiptBatch.create({ data: { batchNumber: 610000 + seq, depositDate: parseDateOnly("2026-08-08") } });
  const pt = await prisma.paymentType.create({ data: { name: `PT-${seq}` } });
  const p = await prisma.payment.create({
    data: { batchId: batch.id, customerId, paymentTypeId: pt.id, amount, receivedDate: parseDateOnly("2026-08-08") },
  });
  return p.id;
}

describe("applications routes", () => {
  it("POST applies a payment for a create-authorized user", async () => {
    const cookie = await signInWith(["receivables.create"]);
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    const res = await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", cookie, {
      paymentId, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }), noParams);
    expect(res.status).toBe(200);
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId } })).toBe(1);
  });

  it("POST refuses an unauthenticated caller (401)", async () => {
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    const res = await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", undefined, {
      paymentId, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }), noParams);
    expect(res.status).toBe(401);
  });

  it("POST refuses a caller without receivables.create (403)", async () => {
    const cookie = await signInWith(["receivables.view"]);
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    const res = await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", cookie, {
      paymentId, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }), noParams);
    expect(res.status).toBe(403);
  });

  it("GET returns the eligible early-pay discount", async () => {
    const cookie = await signInWith(["receivables.view"]);
    const terms = await prisma.terms.create({ data: { name: "R2/10", netDays: 30, discountPercent: "2.00", discountDays: 10 } });
    seq += 1;
    const customer = await prisma.customer.create({ data: { code: `ARD${seq}`, name: "Disc", termsId: terms.id } });
    const order = await prisma.order.create({
      data: { orderNumber: 620000 + seq, customerId: customer.id, status: "SHIPPED", receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01") },
    });
    const invoice = await prisma.invoice.create({
      data: { kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id, invoiceDate: parseDateOnly("2026-08-08"), total: 1000, finalizedAt: new Date() },
    });
    const paymentId = await makePayment(customer.id, 1000);
    const res = await discountRoute(getReq(`http://t/api/receivables/applications?paymentId=${paymentId}&invoiceId=${invoice.id}`, cookie), noParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ discount: 20 });
  });

  it("DELETE voids an application with a reason", async () => {
    const createCookie = await signInWith(["receivables.create"], "creator");
    const deleteCookie = await signInWith(["receivables.delete"], "deleter");
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", createCookie, {
      paymentId, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }), noParams);
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });

    const res = await voidRoute(bodyReq(`http://t/api/receivables/applications/${app.id}`, "DELETE", deleteCookie, { reason: "misapplied" }), withParams({ id: app.id }));
    expect(res.status).toBe(200);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).deletedAt).not.toBeNull();
  });
});

describe("credit-applications route", () => {
  it("POST applies a credit for a create-authorized user", async () => {
    const cookie = await signInWith(["receivables.create"]);
    const credit = await finalizedCredit(-500);
    const inv = await finalizedInvoice(1000);
    const res = await applyCreditRoute(bodyReq("http://t/api/receivables/credit-applications", "POST", cookie, {
      creditInvoiceId: credit.invoiceId, invoiceId: inv.invoiceId, amount: 300,
    }), noParams);
    expect(res.status).toBe(200);
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId, type: "CREDIT" } })).toBe(1);
  });

  it("POST refuses a caller without receivables.create (403)", async () => {
    const cookie = await signInWith(["receivables.view"]);
    const credit = await finalizedCredit(-500);
    const inv = await finalizedInvoice(1000);
    const res = await applyCreditRoute(bodyReq("http://t/api/receivables/credit-applications", "POST", cookie, {
      creditInvoiceId: credit.invoiceId, invoiceId: inv.invoiceId, amount: 300,
    }), noParams);
    expect(res.status).toBe(403);
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId } })).toBe(0);
  });

  it("POST refuses an unauthenticated caller (401)", async () => {
    const credit = await finalizedCredit(-500);
    const inv = await finalizedInvoice(1000);
    const res = await applyCreditRoute(bodyReq("http://t/api/receivables/credit-applications", "POST", undefined, {
      creditInvoiceId: credit.invoiceId, invoiceId: inv.invoiceId, amount: 300,
    }), noParams);
    expect(res.status).toBe(401);
  });
});
