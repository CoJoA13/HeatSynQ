import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { parseDateOnly } from "@/lib/business-days";

import { GET as discountRoute, POST as applyRoute } from "@/app/api/receivables/applications/route";
import { DELETE as voidRoute } from "@/app/api/receivables/applications/[id]/route";
import { POST as applyCreditRoute } from "@/app/api/receivables/credit-applications/route";
import { POST as writeOffRoute } from "@/app/api/receivables/write-offs/route";

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
async function finalizedInvoice(total: number, customerId?: string): Promise<{ invoiceId: string; customerId: string }> {
  seq += 1;
  const cid = customerId ?? (await prisma.customer.create({ data: { code: `ARC${seq}`, name: `AR Route Customer ${seq}` } })).id;
  const order = await prisma.order.create({
    data: {
      orderNumber: 600000 + seq, customerId: cid, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: cid,
      invoiceDate: parseDateOnly("2026-08-08"), total, finalizedAt: new Date(),
    },
  });
  return { invoiceId: invoice.id, customerId: cid };
}
async function finalizedCredit(total: number, customerId?: string): Promise<{ invoiceId: string; customerId: string }> {
  seq += 1;
  const cid = customerId ?? (await prisma.customer.create({ data: { code: `ARCR${seq}`, name: `AR Credit Route Customer ${seq}` } })).id;
  const order = await prisma.order.create({
    data: {
      orderNumber: 630000 + seq, customerId: cid, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
  const credit = await prisma.invoice.create({
    data: {
      kind: "CREDIT", status: "FINALIZED", orderId: order.id, customerId: cid,
      invoiceDate: parseDateOnly("2026-08-08"), total, finalizedAt: new Date(),
    },
  });
  return { invoiceId: credit.id, customerId: cid };
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
  it("POST applies a payment for a caller holding receivables.create AND action.apply_payments", async () => {
    const cookie = await signInWith(["receivables.create", "action.apply_payments"]);
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

  it("POST refuses a payment line targeting an unrelated customer's invoice (400)", async () => {
    const cookie = await signInWith(["receivables.create", "action.apply_payments"]);
    const payerInv = await finalizedInvoice(1000);
    const strangerInv = await finalizedInvoice(1000); // a different, unrelated customer
    const paymentId = await makePayment(payerInv.customerId, 600);
    const res = await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", cookie, {
      paymentId, lines: [{ invoiceId: strangerInv.invoiceId, type: "PAYMENT", amount: 100 }],
    }), noParams);
    expect(res.status).toBe(400);
    expect(await prisma.application.count({ where: { invoiceId: strangerInv.invoiceId } })).toBe(0);
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

  // #211 (owner ruling, 2026-08-25): applying cash is the spec's named dangerous action
  // `apply_payments` — `receivables.create` alone records payments/batches but no longer applies
  // them. The cookie deliberately HOLDS receivables.create, so the only 403 this request can
  // produce is the apply_payments gate — with that mustDo deleted, the apply succeeds (200) and
  // the count assertion reds. (The #233 lesson: never let a different layer's 403 satisfy the test.)
  it("POST refuses a caller without action.apply_payments, even holding receivables.create (403)", async () => {
    const cookie = await signInWith(["receivables.create"], "ap-no-special");
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    const res = await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", cookie, {
      paymentId, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }), noParams);
    expect(res.status).toBe(403);
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId } })).toBe(0);
  });

  it("POST refuses a WRITE_OFF line without action.write_off, even holding receivables.create and apply_payments (403)", async () => {
    const cookie = await signInWith(["receivables.create", "action.apply_payments"], "wo-no-special");
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    const res = await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", cookie, {
      paymentId, lines: [{ invoiceId: inv.invoiceId, type: "WRITE_OFF", amount: 100, reason: "uncollectable" }],
    }), noParams);
    expect(res.status).toBe(403);
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId } })).toBe(0);
  });

  it("POST applies a WRITE_OFF line for a session holding receivables.create AND action.write_off", async () => {
    const cookie = await signInWith(["receivables.create", "action.apply_payments", "action.write_off"], "wo-with-special");
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    const res = await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", cookie, {
      paymentId, lines: [{ invoiceId: inv.invoiceId, type: "WRITE_OFF", amount: 100, reason: "uncollectable" }],
    }), noParams);
    expect(res.status).toBe(200);
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId, type: "WRITE_OFF" } })).toBe(1);
  });

  it("POST applies a mixed PAYMENT+WRITE_OFF submission only when the caller holds action.write_off", async () => {
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    const mixedLines = [
      { invoiceId: inv.invoiceId, type: "PAYMENT", amount: 500 },
      { invoiceId: inv.invoiceId, type: "WRITE_OFF", amount: 100, reason: "small remainder" },
    ];

    const withoutSpecial = await signInWith(["receivables.create", "action.apply_payments"], "wo-mixed-wrong");
    const denied = await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", withoutSpecial, {
      paymentId, lines: mixedLines,
    }), noParams);
    expect(denied.status).toBe(403);
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId } })).toBe(0);

    const withSpecial = await signInWith(["receivables.create", "action.apply_payments", "action.write_off"], "wo-mixed-ok");
    const allowed = await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", withSpecial, {
      paymentId, lines: mixedLines,
    }), noParams);
    expect(allowed.status).toBe(200);
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId } })).toBe(2);
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
      // #79: the discount now comes off the invoice's OWN frozen pair, not the customer's live
      // terms, so this row has to carry what `finalizeInvoice` would have written for it.
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
        invoiceDate: parseDateOnly("2026-08-08"), total: 1000, finalizedAt: new Date(),
        termsDiscountPercent: "2.00", termsDiscountDays: 10,
      },
    });
    const paymentId = await makePayment(customer.id, 1000);
    const res = await discountRoute(getReq(`http://t/api/receivables/applications?paymentId=${paymentId}&invoiceId=${invoice.id}`, cookie), noParams);
    expect(res.status).toBe(200);
    // #155 arm 2: the WHOLE envelope, not just `discount.amount`. This assertion is the reason the
    // rename to `discountOffer` was not, on its own, the forcing function it looked like: `tsc` types
    // `res.json()` as `any`, so a widened wire shape breaks nothing at compile time and only a
    // route-level test can see it. It asserted the old flat `discount: 20` and went red on the full
    // suite, having been missed because the task's own gate ran a neighbouring file.
    expect(await res.json()).toEqual({
      open: 1000,
      discount: { amount: 20, blockedBy: null, settlingAmount: null, wouldEarn: null },
    });
  });

  // The other side of the envelope, over the wire: when the offer is blocked because this receipt
  // cannot settle, the two figures the screen renders its hint from must actually arrive. The
  // service test pins the arithmetic; this pins that it survives serialization.
  it("GET ?paymentId=&invoiceId= carries the settling figures when the receipt cannot settle", async () => {
    const cookie = await signInWith(["receivables.view"]);
    const terms = await prisma.terms.create({ data: { name: `RB2/10-${seq}`, netDays: 30, discountPercent: "2.00", discountDays: 10 } });
    seq += 1;
    const customer = await prisma.customer.create({ data: { code: `ARB${seq}`, name: "Blocked", termsId: terms.id } });
    const order = await prisma.order.create({
      data: { orderNumber: 630000 + seq, customerId: customer.id, status: "SHIPPED", receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01") },
    });
    const invoice = await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
        invoiceDate: parseDateOnly("2026-08-08"), total: 1000, finalizedAt: new Date(),
        termsDiscountPercent: "2.00", termsDiscountDays: 10,
      },
    });
    // 500.00 against a 1,000.00 invoice: inside the window, but nowhere near settling it.
    const paymentId = await makePayment(customer.id, 500);
    const res = await discountRoute(getReq(`http://t/api/receivables/applications?paymentId=${paymentId}&invoiceId=${invoice.id}`, cookie), noParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      open: 1000,
      discount: { amount: 0, blockedBy: "would_not_settle", settlingAmount: 980, wouldEarn: 20 },
    });
  });

  it("GET ?paymentId=&invoiceId= reflects a balance already reduced by a prior application", async () => {
    const cookie = await signInWith(["receivables.create", "action.apply_payments", "receivables.view"]);
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

  it("DELETE refuses an unauthenticated caller (401)", async () => {
    const res = await voidRoute(bodyReq("http://t/api/receivables/applications/nope", "DELETE", undefined, { reason: "misapplied" }), withParams({ id: "nope" }));
    expect(res.status).toBe(401);
  });

  it("DELETE refuses a caller without receivables.delete (403)", async () => {
    const createCookie = await signInWith(["receivables.create", "action.apply_payments"], "del-403-creator");
    const wrong = await signInWith(["receivables.edit"], "del-403-wrong");
    const inv = await finalizedInvoice(1000);
    const paymentId = await makePayment(inv.customerId, 600);
    await applyRoute(bodyReq("http://t/api/receivables/applications", "POST", createCookie, {
      paymentId, lines: [{ invoiceId: inv.invoiceId, type: "PAYMENT", amount: 600 }],
    }), noParams);
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });

    const res = await voidRoute(bodyReq(`http://t/api/receivables/applications/${app.id}`, "DELETE", wrong, { reason: "misapplied" }), withParams({ id: app.id }));
    expect(res.status).toBe(403);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).deletedAt).toBeNull();
  });

  it("DELETE voids an application with a reason", async () => {
    const createCookie = await signInWith(["receivables.create", "action.apply_payments"], "creator");
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
  it("POST applies a credit for a caller holding receivables.create AND action.apply_payments", async () => {
    const cookie = await signInWith(["receivables.create", "action.apply_payments"]);
    const inv = await finalizedInvoice(1000);
    const credit = await finalizedCredit(-500, inv.customerId); // same customer/family
    const res = await applyCreditRoute(bodyReq("http://t/api/receivables/credit-applications", "POST", cookie, {
      creditInvoiceId: credit.invoiceId, invoiceId: inv.invoiceId, amount: 300,
    }), noParams);
    expect(res.status).toBe(200);
    expect(await prisma.application.count({ where: { invoiceId: inv.invoiceId, type: "CREDIT" } })).toBe(1);
  });

  it("POST refuses a credit applied to an unrelated customer's invoice (400)", async () => {
    const cookie = await signInWith(["receivables.create", "action.apply_payments"]);
    const credit = await finalizedCredit(-500);
    const strangerInv = await finalizedInvoice(1000); // a different, unrelated customer
    const res = await applyCreditRoute(bodyReq("http://t/api/receivables/credit-applications", "POST", cookie, {
      creditInvoiceId: credit.invoiceId, invoiceId: strangerInv.invoiceId, amount: 100,
    }), noParams);
    expect(res.status).toBe(400);
    expect(await prisma.application.count()).toBe(0);
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

  // #211: same falsifiability construction as the applications-route twin above — the cookie
  // holds receivables.create, so this 403 can only be the apply_payments gate.
  it("POST refuses a caller without action.apply_payments, even holding receivables.create (403)", async () => {
    const cookie = await signInWith(["receivables.create"], "credit-ap-no-special");
    const credit = await finalizedCredit(-500);
    const inv = await finalizedInvoice(1000, credit.customerId);
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

// The standalone bad-debt write-off (#77). Unlike the apply route — which peeks at its body for a
// WRITE_OFF line because it also carries PAYMENT/DISCOUNT ones — this route writes nothing else, so
// BOTH `receivables.create` and the `write_off` special action are required unconditionally. The
// service's own guards (claims, over-application, reason, period) are exercised in
// tests/write-offs.test.ts; these four cases are the gate.
describe("write-offs route", () => {
  const url = "http://t/api/receivables/write-offs";

  it("POST refuses an unauthenticated caller (401)", async () => {
    const inv = await finalizedInvoice(1000);
    const res = await writeOffRoute(bodyReq(url, "POST", undefined, {
      invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable",
    }), noParams);
    expect(res.status).toBe(401);
    expect(await prisma.application.count()).toBe(0);
  });

  it("POST refuses receivables.create WITHOUT action.write_off (403)", async () => {
    const cookie = await signInWith(["receivables.create"], "swo-no-special");
    const inv = await finalizedInvoice(1000);
    const res = await writeOffRoute(bodyReq(url, "POST", cookie, {
      invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable",
    }), noParams);
    expect(res.status).toBe(403);
    expect(await prisma.application.count()).toBe(0);
  });

  it("POST refuses action.write_off WITHOUT receivables.create (403)", async () => {
    const cookie = await signInWith(["receivables.view", "action.write_off"], "swo-no-create");
    const inv = await finalizedInvoice(1000);
    const res = await writeOffRoute(bodyReq(url, "POST", cookie, {
      invoiceId: inv.invoiceId, amount: 1000, reason: "uncollectable",
    }), noParams);
    expect(res.status).toBe(403);
    expect(await prisma.application.count()).toBe(0);
  });

  it("POST writes off the balance for a session holding BOTH (200)", async () => {
    const cookie = await signInWith(["receivables.create", "action.write_off"], "swo-both");
    const inv = await finalizedInvoice(1000);
    const res = await writeOffRoute(bodyReq(url, "POST", cookie, {
      invoiceId: inv.invoiceId, amount: 1000, reason: "customer in liquidation",
    }), noParams);
    expect(res.status).toBe(200);
    const app = await prisma.application.findFirstOrThrow({ where: { invoiceId: inv.invoiceId } });
    expect(app.type).toBe("WRITE_OFF");
    expect(app.paymentId).toBeNull(); // the standalone flavor — no receipt was fabricated
  });

  // The #8 lesson, applied at birth rather than found later: a literal `null` body must reach zod
  // and come back as a 400, never a TypeError escaping the handler as a 500.
  it("POST answers a null JSON body with a 400, not a 500", async () => {
    const cookie = await signInWith(["receivables.create", "action.write_off"], "swo-null-body");
    const res = await writeOffRoute(new Request(url, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: "null",
    }), noParams);
    expect(res.status).toBe(400);
  });
});
