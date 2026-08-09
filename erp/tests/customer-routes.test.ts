import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { GET as list, POST as create } from "@/app/api/customers/route";
import { GET as detail, PUT as update, DELETE as remove } from "@/app/api/customers/[id]/route";
import { GET as blockersRoute } from "@/app/api/customers/[id]/blockers/route";
import { GET as blockersExportRoute } from "@/app/api/customers/[id]/blockers/export/route";
import { GET as receivablesRoute } from "@/app/api/customers/[id]/receivables/route";
import { createCustomer } from "@/server/customers";
import { createPart } from "@/server/parts";
import { createOrder } from "@/server/orders";
import { parseDateOnly } from "@/lib/business-days";

const noParams = { params: Promise.resolve({}) };
const withId = (id: string) => ({ params: Promise.resolve({ id }) });

function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

describe("customer routes", () => {
  beforeEach(async () => await truncateAll());

  it("401s every verb without a session", async () => {
    expect((await list(new Request("http://t/api/customers"), noParams)).status).toBe(401);
    expect((await create(new Request("http://t/api/customers", { method: "POST", body: "{}" }), noParams)).status).toBe(401);
    expect((await detail(new Request("http://t/api/customers/x"), withId("x"))).status).toBe(401);
    expect((await update(new Request("http://t/api/customers/x", { method: "PUT", body: "{}" }), withId("x"))).status).toBe(401);
    expect((await remove(new Request("http://t/api/customers/x", { method: "DELETE" }), withId("x"))).status).toBe(401);
  });

  it("403s each verb the user lacks, while view still works", async () => {
    const cookie = await signInWith(["customers.view"]);
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });

    expect((await list(new Request("http://t/api/customers", { headers: { cookie } }), noParams)).status).toBe(200);
    expect((await detail(new Request(`http://t/api/customers/${id}`, { headers: { cookie } }), withId(id))).status).toBe(200);

    const post = await create(new Request("http://t/api/customers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "NEW", name: "New" }),
    }), noParams);
    expect(post.status).toBe(403);

    const put = await update(new Request(`http://t/api/customers/${id}`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    }), withId(id));
    expect(put.status).toBe(403);

    const del = await remove(new Request(`http://t/api/customers/${id}`, {
      method: "DELETE", headers: { cookie },
    }), withId(id));
    expect(del.status).toBe(403);
  });

  // G2: `(await req.json().catch(() => ({}))) as { reason?: unknown }` threw a raw TypeError
  // reading `.reason` off a JSON body of `null`, escaping handle()'s error mapping as an
  // unhandled 500 instead of the service's own missing-reason 400. Identical shape to
  // /api/parts/[id]'s DELETE (parts-routes.test.ts).
  it("DELETE with a JSON null body is 400, not 500; a valid reason still deletes", async () => {
    const cookie = await signInWith(["customers.view", "customers.create", "customers.delete"], "del-null-1");
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });

    const nullBody = await remove(new Request(`http://t/api/customers/${id}`, {
      method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: "null",
    }), withId(id));
    expect(nullBody.status).toBe(400);
    expect((await nullBody.json()).error).toMatch(/reason/i);

    const ok = await remove(new Request(`http://t/api/customers/${id}`, {
      method: "DELETE", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "test reason" }),
    }), withId(id));
    expect(ok.status).toBe(200);
  });

  it("round-trips a create through the route and honours search", async () => {
    const cookie = await signInWith(["customers.view", "customers.create"]);
    const res = await create(new Request("http://t/api/customers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "ACME", name: "Acme Foundry" }),
    }), noParams);
    expect(res.status).toBe(200);

    const found = await list(new Request("http://t/api/customers?search=acme", { headers: { cookie } }), noParams);
    expect((await found.json()).map((c: { code: string }) => c.code)).toEqual(["ACME"]);
  });

  it("surfaces a duplicate code as a readable 400", async () => {
    const cookie = await signInWith(["customers.view", "customers.create"]);
    await createCustomer({ code: "ACME", name: "Acme" });
    const res = await create(new Request("http://t/api/customers", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: "ACME", name: "Dup" }),
    }), noParams);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already exists/i);
  });

  // H4 (Codex round 3 review): mirrors the part-fields blockers/export route tests
  // (parts-routes.test.ts) — same 401/403/200 shape, same xlsx content-type and disposition.
  // Task 15 extends this to the COMBINED part+order list: the route now unions
  // customerPartBlockers with the new customerOrderBlockers (customers.ts) so a refusal is never
  // discoverable for only half of what's blocking it.
  it("blockers and blockers/export: 401, 403, 200 with the combined part+order list, xlsx content-type", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    const { id: partId } = await createPart({ customerId: id, partNumber: "12345", eachWeight: 1 });
    const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
    const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
    await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "x" },
    });
    const { order } = await createOrder({ customerId: id, lines: [{ partId, qty: 1, weight: "10.00" }] });

    expect((await blockersRoute(getReq(`http://t/api/customers/${id}/blockers`), withId(id))).status).toBe(401);
    expect((await blockersExportRoute(getReq(`http://t/api/customers/${id}/blockers/export`), withId(id))).status)
      .toBe(401);

    const viewer = await signInWith(["customers.view"], "cust-blockers-viewer-1");
    const blockers = await blockersRoute(getReq(`http://t/api/customers/${id}/blockers`, viewer), withId(id));
    expect(blockers.status).toBe(200);
    expect(await blockers.json()).toEqual([
      { entityLabel: "Part", name: "ACME · 12345", id: partId, href: `/parts/${partId}` },
      { entityLabel: "Order", name: `#${order.orderNumber} · ACME`, id: order.id, href: `/orders/${order.id}` },
    ]);

    const wrong = await signInWith(["admin.view"], "cust-blockers-wrong-1");
    expect((await blockersRoute(getReq(`http://t/api/customers/${id}/blockers`, wrong), withId(id))).status)
      .toBe(403);
    expect((await blockersExportRoute(getReq(`http://t/api/customers/${id}/blockers/export`, wrong), withId(id))).status)
      .toBe(403);

    const exportRes = await blockersExportRoute(
      getReq(`http://t/api/customers/${id}/blockers/export`, viewer), withId(id));
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(exportRes.headers.get("content-disposition")).toContain("attachment");
    expect(exportRes.headers.get("content-disposition")).toContain(".xlsx");
  });

  // Task 15: the customer page's A/R section — `GET /api/customers/[id]/receivables`
  // (`customerReceivablesSummary`, src/server/customer-receivables.ts), gated receivables.view
  // (not customers.view — this is A/R data, the aging/applications GET routes' own gate).
  it("GET .../receivables: 401, 403, and 200 with the aging summary + open items with receivables.view", async () => {
    const { id } = await createCustomer({ code: "ARCUST", name: "AR Customer" });
    const order = await prisma.order.create({
      data: {
        orderNumber: 950001, customerId: id, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-06-01"), requestDate: parseDateOnly("2026-06-01"),
      },
    });
    await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: id,
        invoiceDate: parseDateOnly("2026-06-01"), dueDate: parseDateOnly("2026-07-01"),
        total: 400, finalizedAt: parseDateOnly("2026-06-01"),
      },
    });

    expect((await receivablesRoute(getReq(`http://t/api/customers/${id}/receivables`), withId(id))).status)
      .toBe(401);

    const wrong = await signInWith(["customers.view"], "cust-recv-wrong-1");
    expect((await receivablesRoute(getReq(`http://t/api/customers/${id}/receivables`, wrong), withId(id))).status)
      .toBe(403);

    const viewer = await signInWith(["receivables.view"], "cust-recv-viewer-1");
    const res = await receivablesRoute(getReq(`http://t/api/customers/${id}/receivables`, viewer), withId(id));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      aging: { customerId: string; net: number };
      openItems: { id: string; customerId: string; open: number }[];
    };
    expect(body.aging.customerId).toBe(id);
    expect(body.aging.net).toBe(400);
    expect(body.openItems).toHaveLength(1);
    expect(body.openItems[0].customerId).toBe(id);
    expect(body.openItems[0].open).toBe(400);
  });

  it("GET .../receivables: 404s an unknown customer", async () => {
    const viewer = await signInWith(["receivables.view"], "cust-recv-404");
    const res = await receivablesRoute(getReq("http://t/api/customers/nope/receivables", viewer), withId("nope"));
    expect(res.status).toBe(404);
  });

  // Task 15 fix round 1 (review finding, Important): `agingReport({customerId})` and
  // `openInvoicesForPayer(customerId)` diverge in scope for a DIVISION — the former returns only
  // that customer's own row, the latter resolves the whole family (parent + every sibling). The
  // earlier version of `customerReceivablesSummary` composed the two as if they agreed, so a
  // division's page showed a net scoped to itself above an open-items table actually listing its
  // parent's and siblings' invoices. This regression proves BOTH figures are now scoped to the ONE
  // customer whose page it is — parent and child alike — never a family roll-up. Each of parent
  // and child carries its own finalized open invoice AND its own on-account payment, so a
  // family-leak would show up as either an extra open item OR a `net`/`unapplied` that includes
  // the other customer's payment.
  it("GET .../receivables scopes to the ONE customer's own A/R, never its family (division regression)", async () => {
    const { id: parentId } = await createCustomer({ code: "ARFAM-P", name: "AR Family Parent" });
    const { id: childId } = await createCustomer({ code: "ARFAM-C", name: "AR Family Child", parentId });

    const parentOrder = await prisma.order.create({
      data: {
        orderNumber: 951001, customerId: parentId, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-06-01"), requestDate: parseDateOnly("2026-06-01"),
      },
    });
    const parentInvoice = await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: parentOrder.id, customerId: parentId,
        invoiceDate: parseDateOnly("2026-06-01"), dueDate: parseDateOnly("2026-07-01"),
        total: 300, finalizedAt: parseDateOnly("2026-06-01"),
      },
    });

    const childOrder = await prisma.order.create({
      data: {
        orderNumber: 951002, customerId: childId, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-06-01"), requestDate: parseDateOnly("2026-06-01"),
      },
    });
    const childInvoice = await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: childOrder.id, customerId: childId,
        invoiceDate: parseDateOnly("2026-06-01"), dueDate: parseDateOnly("2026-07-01"),
        total: 500, finalizedAt: parseDateOnly("2026-06-01"),
      },
    });

    // An on-account payment (no application) for EACH — non-trivial `unapplied`/`net`, and proof
    // a family roll-up isn't sneaking one customer's cash into the other's figures.
    const batch = await prisma.receiptBatch.create({
      data: { batchNumber: 951000, depositDate: parseDateOnly("2026-06-01") },
    });
    const paymentType = await prisma.paymentType.create({ data: { name: "ARFAM-Check" } });
    await prisma.payment.create({
      data: {
        batchId: batch.id, customerId: parentId, paymentTypeId: paymentType.id,
        amount: 50, receivedDate: parseDateOnly("2026-06-01"),
      },
    });
    await prisma.payment.create({
      data: {
        batchId: batch.id, customerId: childId, paymentTypeId: paymentType.id,
        amount: 100, receivedDate: parseDateOnly("2026-06-01"),
      },
    });

    const viewer = await signInWith(["receivables.view"], "cust-recv-family-viewer");

    type Summary = {
      aging: { customerId: string; unapplied: number; net: number };
      openItems: { id: string; customerId: string; open: number }[];
    };

    // The CHILD's page: only the child's own invoice, only the child's own on-account cash.
    const childRes = await receivablesRoute(getReq(`http://t/api/customers/${childId}/receivables`, viewer), withId(childId));
    expect(childRes.status).toBe(200);
    const childBody = await childRes.json() as Summary;
    expect(childBody.aging.customerId).toBe(childId);
    expect(childBody.aging.unapplied).toBe(100);
    expect(childBody.aging.net).toBe(400); // 500 open − 100 on account
    expect(childBody.openItems).toHaveLength(1);
    expect(childBody.openItems[0].id).toBe(childInvoice.id);
    expect(childBody.openItems[0].customerId).toBe(childId);
    expect(childBody.openItems[0].open).toBe(500);

    // The PARENT's page: only the parent's own invoice, only the parent's own on-account cash —
    // NOT the child's, even though the parent is a family head.
    const parentRes = await receivablesRoute(getReq(`http://t/api/customers/${parentId}/receivables`, viewer), withId(parentId));
    expect(parentRes.status).toBe(200);
    const parentBody = await parentRes.json() as Summary;
    expect(parentBody.aging.customerId).toBe(parentId);
    expect(parentBody.aging.unapplied).toBe(50);
    expect(parentBody.aging.net).toBe(250); // 300 open − 50 on account
    expect(parentBody.openItems).toHaveLength(1);
    expect(parentBody.openItems[0].id).toBe(parentInvoice.id);
    expect(parentBody.openItems[0].customerId).toBe(parentId);
    expect(parentBody.openItems[0].open).toBe(300);
  });
});
