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

  it("GET ?customerId= refuses an unauthenticated caller (401)", async () => {
    const inv = await finalizedInvoice(1000);
    const res = await discountRoute(getReq(`http://t/api/receivables/applications?customerId=${inv.customerId}`), noParams);
    expect(res.status).toBe(401);
  });

  it("GET ?customerId= refuses a caller without receivables.view (403)", async () => {
    const cookie = await signInWith(["receivables.create"]);
    const inv = await finalizedInvoice(1000);
    const res = await discountRoute(getReq(`http://t/api/receivables/applications?customerId=${inv.customerId}`, cookie), noParams);
    expect(res.status).toBe(403);
  });

  it("GET ?paymentId=&invoiceId= refuses an unauthenticated caller (401)", async () => {
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    const res = await discountRoute(
      getReq(`http://t/api/receivables/applications?paymentId=${paymentId}&invoiceId=${inv.invoiceId}`), noParams);
    expect(res.status).toBe(401);
  });

  it("GET ?paymentId=&invoiceId= refuses a caller without receivables.view (403)", async () => {
    const cookie = await signInWith(["receivables.create"]);
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    const res = await discountRoute(
      getReq(`http://t/api/receivables/applications?paymentId=${paymentId}&invoiceId=${inv.invoiceId}`, cookie), noParams);
    expect(res.status).toBe(403);
  });

  it("GET ?paymentId=&invoiceId= returns the live open balance and the eligible early-pay discount", async () => {
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
    expect(await res.json()).toEqual({ open: 1000, discount: 20 });
  });

  it("GET ?paymentId=&invoiceId= reflects a balance already reduced by a prior application", async () => {
    const cookie = await signInWith(["receivables.create", "receivables.view"]);
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", cookie, {
      paymentId, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }), noParams);
    const res = await discountRoute(getReq(`http://t/api/receivables/applications?paymentId=${paymentId}&invoiceId=${inv.invoiceId}`, cookie), noParams);
    expect(res.status).toBe(200);
    expect((await res.json()).open).toBe(400);
  });

  it("GET ?customerId= lists the payer's open finalized invoices, excluding credits and settled ones", async () => {
    const cookie = await signInWith(["receivables.view"]);
    const invA = await finalizedInvoice(1000);
    const invB = await finalizedInvoice(500);
    const credit = await finalizedCredit(-200);
    // A second invoice on the SAME customer as invA, fully settled — must not appear.
    seq += 1;
    const order = await prisma.order.create({
      data: { orderNumber: 640000 + seq, customerId: invA.customerId, status: "SHIPPED", receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01") },
    });
    const settled = await prisma.invoice.create({
      data: { kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: invA.customerId, invoiceDate: parseDateOnly("2026-08-08"), total: 300, finalizedAt: new Date() },
    });
    const payment = await prisma.payment.create({
      data: { batchId: (await prisma.receiptBatch.create({ data: { batchNumber: 650000 + seq, depositDate: parseDateOnly("2026-08-08") } })).id,
        customerId: invA.customerId, paymentTypeId: (await prisma.paymentType.create({ data: { name: `PTS-${seq}` } })).id,
        amount: 300, receivedDate: parseDateOnly("2026-08-08") },
    });
    await prisma.application.create({
      data: { invoiceId: settled.id, amount: 300, type: "PAYMENT", paymentId: payment.id, appliedDate: parseDateOnly("2026-08-08") },
    });

    const res = await discountRoute(getReq(`http://t/api/receivables/applications?customerId=${invA.customerId}`, cookie), noParams);
    expect(res.status).toBe(200);
    const rows = await res.json();
    const ids = rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(invA.invoiceId);
    expect(ids).not.toContain(invB.invoiceId); // different customer, no family relation
    expect(ids).not.toContain(credit.invoiceId); // a CREDIT is never a payment target
    expect(ids).not.toContain(settled.id); // fully settled — not an open item
    const rowA = rows.find((r: { id: string }) => r.id === invA.invoiceId);
    expect(rowA.open).toBe(1000);
  });

  it("GET ?customerId= rolls up the family from a CHILD payer (parent + every sibling)", async () => {
    const cookie = await signInWith(["receivables.view"]);
    seq += 1;
    const parent = await prisma.customer.create({ data: { code: `ARP${seq}`, name: `Parent ${seq}` } });
    const childA = await prisma.customer.create({ data: { code: `ARCA${seq}`, name: `Child A ${seq}`, parentId: parent.id } });
    const childB = await prisma.customer.create({ data: { code: `ARCB${seq}`, name: `Child B ${seq}`, parentId: parent.id } });
    async function invoiceFor(customerId: string, total: number) {
      seq += 1;
      const order = await prisma.order.create({
        data: { orderNumber: 660000 + seq, customerId, status: "SHIPPED", receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01") },
      });
      return prisma.invoice.create({
        data: { kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId, invoiceDate: parseDateOnly("2026-08-08"), total, finalizedAt: new Date() },
      });
    }
    const parentInv = await invoiceFor(parent.id, 100);
    const childAInv = await invoiceFor(childA.id, 200);
    const childBInv = await invoiceFor(childB.id, 300);

    // Querying from childA (a CHILD, not the parent) must still roll up parent + childB.
    const res = await discountRoute(getReq(`http://t/api/receivables/applications?customerId=${childA.id}`, cookie), noParams);
    expect(res.status).toBe(200);
    const ids = (await res.json()).map((r: { id: string }) => r.id);
    expect(ids.sort()).toEqual([parentInv.id, childAInv.id, childBInv.id].sort());
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
