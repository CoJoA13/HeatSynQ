import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
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
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

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

  /**
   * Codex, PR #129 — the payment blockers must not leak A/R figures through a `customers.view`
   * route. The blockers route is gated on `customers.view`, and #84 added payment rows carrying the
   * receipt AMOUNT, which every dedicated receivables read requires `receivables.view` for.
   *
   * The fix withholds the amount, NOT the row: §5.14's promise is owed to whoever holds
   * `customers.delete` whatever their A/R grants, so suppressing the blocker entirely would hand
   * them a "1 live payment(s)" refusal above an EMPTY list — the exact dead end the panel exists to
   * prevent. A batch number is an internal sequence identifier, not a financial figure, so it stays:
   * it is what lets them tell a receivables user WHICH deposit to look at.
   */
  it("blockers: withholds the payment AMOUNT from a caller without receivables.view, but still names the blocker", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    const paymentType = await prisma.paymentType.create({ data: { name: "Check" } });
    const batch = await prisma.receiptBatch.create({
      data: { batchNumber: 1000, depositDate: parseDateOnly("2026-08-08") },
    });
    const pay = await prisma.payment.create({
      data: {
        batchId: batch.id, customerId: id, paymentTypeId: paymentType.id,
        amount: 300, reference: "1234", receivedDate: parseDateOnly("2026-08-08"),
      },
    });

    const customersOnly = await signInWith(["customers.view"], "cust-blockers-nofin");
    const redacted = await blockersRoute(
      getReq(`http://t/api/customers/${id}/blockers`, customersOnly), withId(id));
    expect(await redacted.json()).toEqual([
      { entityLabel: "Payment", name: "Batch #1000", id: pay.id, href: `/receivables/batches/${batch.id}` },
    ]);

    const withAr = await signInWith(["customers.view", "receivables.view"], "cust-blockers-fin");
    const full = await blockersRoute(getReq(`http://t/api/customers/${id}/blockers`, withAr), withId(id));
    expect(await full.json()).toEqual([
      { entityLabel: "Payment", name: "Batch #1000 · 300.00", id: pay.id, href: `/receivables/batches/${batch.id}` },
    ]);

    // The EXPORT is the same data in a downloadable workbook — it must redact identically, or the
    // leak simply moves to the file.
    const sheet = await blockersExportRoute(
      getReq(`http://t/api/customers/${id}/blockers/export`, customersOnly), withId(id));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await sheet.arrayBuffer()) as unknown as ArrayBuffer);
    const row = (wb.getWorksheet(1)!.getRow(2).values as unknown[]).map(String).join(" ");
    expect(row).toContain("Batch #1000");
    expect(row).not.toContain("300.00");
  });

  // H4 (Codex round 3 review): mirrors the part-fields blockers/export route tests
  // (parts-routes.test.ts) — same 401/403/200 shape, same xlsx content-type and disposition.
  // Task 15 extends this to the COMBINED part+order list: the route now unions
  // customerPartBlockers with the new customerOrderBlockers (customers.ts) so a refusal is never
  // discoverable for only half of what's blocking it. Task 7 (Phase 6) makes it three-way: live
  // quotes join the union, and the Excel export carries the quote rows too (§5.14's third leg).
  it("blockers and blockers/export: 401, 403, 200 with the combined part+order+quote list, xlsx content-type", async () => {
    const { id } = await createCustomer({ code: "ACME", name: "Acme" });
    const { id: partId } = await createPart({ customerId: id, partNumber: "12345", eachWeight: 1 });
    const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
    const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
    await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "x" },
    });
    const { order } = await createOrder({ customerId: id, lines: [{ partId, qty: 1, weight: "10.00" }] });
    const quoteUser = await prisma.user.create({
      data: { username: "quoter-cust-routes", passwordHash: "x", displayName: "Quoter" } });
    const quote = await prisma.quote.create({ data: {
      quoteNumber: 1000, customerId: id, quotedById: quoteUser.id,
      quoteDate: new Date("2026-08-01"), effectiveDate: new Date("2026-08-01"),
      expiryDate: new Date("2026-08-31"),
      lines: { create: [{ position: 1, partNumberText: "FT-1" }] },
    } });

    expect((await blockersRoute(getReq(`http://t/api/customers/${id}/blockers`), withId(id))).status).toBe(401);
    expect((await blockersExportRoute(getReq(`http://t/api/customers/${id}/blockers/export`), withId(id))).status)
      .toBe(401);

    const viewer = await signInWith(["customers.view"], "cust-blockers-viewer-1");
    const blockers = await blockersRoute(getReq(`http://t/api/customers/${id}/blockers`, viewer), withId(id));
    expect(blockers.status).toBe(200);
    expect(await blockers.json()).toEqual([
      { entityLabel: "Part", name: "ACME · 12345", id: partId, href: `/parts/${partId}` },
      { entityLabel: "Order", name: `#${order.orderNumber} · ACME`, id: order.id, href: `/orders/${order.id}` },
      { entityLabel: "Quote", name: "Quote · #1000", id: quote.id, href: `/quotes/${quote.id}` },
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

    // The workbook carries all three categories (the reference-blockers export precedent for
    // reading it back; see tests/excel.test.ts for the Buffer cast).
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await exportRes.arrayBuffer()) as unknown as ArrayBuffer);
    const rows = [2, 3, 4].map((n) =>
      (wb.getWorksheet(1)!.getRow(n).values as unknown[]).map(String));
    expect(rows[0]).toContain("Part");
    expect(rows[1]).toContain("Order");
    expect(rows[2]).toContain("Quote");
    expect(rows[2]).toContain("Quote · #1000");
    expect(rows[2]).toContain(`/quotes/${quote.id}`);
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
      openItems: { id: string; kind: string; open: number }[];
    };
    expect(body.aging.customerId).toBe(id);
    expect(body.aging.net).toBe(400);
    expect(body.openItems).toHaveLength(1);
    expect(body.openItems[0].kind).toBe("INVOICE");
    expect(body.openItems[0].open).toBe(400);
    // #83's property: the rows sum to the net printed above them.
    expect(body.openItems.reduce((t, i) => t + i.open, 0)).toBe(body.aging.net);
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
      openItems: { id: string; kind: string; open: number }[];
    };

    // The CHILD's page: only the child's own invoice, only the child's own on-account cash.
    // Since #83 that cash is a ROW of its own (negative), not just a number folded into the strip —
    // which is what makes the family-leak check stronger, not weaker: a leak would now show up as
    // an extra row as well as a wrong total.
    const childRes = await receivablesRoute(getReq(`http://t/api/customers/${childId}/receivables`, viewer), withId(childId));
    expect(childRes.status).toBe(200);
    const childBody = await childRes.json() as Summary;
    expect(childBody.aging.customerId).toBe(childId);
    expect(childBody.aging.unapplied).toBe(100);
    expect(childBody.aging.net).toBe(400); // 500 open − 100 on account
    expect(childBody.openItems).toHaveLength(2);
    expect(childBody.openItems.find((i) => i.kind === "INVOICE")!.id).toBe(childInvoice.id);
    expect(childBody.openItems.find((i) => i.kind === "INVOICE")!.open).toBe(500);
    expect(childBody.openItems.find((i) => i.kind === "PAYMENT")!.open).toBe(-100);
    expect(childBody.openItems.reduce((t, i) => t + i.open, 0)).toBe(childBody.aging.net);
    // The parent's invoice is nowhere in the child's list.
    expect(childBody.openItems.some((i) => i.id === parentInvoice.id)).toBe(false);

    // The PARENT's page: only the parent's own invoice, only the parent's own on-account cash —
    // NOT the child's, even though the parent is a family head.
    const parentRes = await receivablesRoute(getReq(`http://t/api/customers/${parentId}/receivables`, viewer), withId(parentId));
    expect(parentRes.status).toBe(200);
    const parentBody = await parentRes.json() as Summary;
    expect(parentBody.aging.customerId).toBe(parentId);
    expect(parentBody.aging.unapplied).toBe(50);
    expect(parentBody.aging.net).toBe(250); // 300 open − 50 on account
    expect(parentBody.openItems).toHaveLength(2);
    expect(parentBody.openItems.find((i) => i.kind === "INVOICE")!.id).toBe(parentInvoice.id);
    expect(parentBody.openItems.find((i) => i.kind === "INVOICE")!.open).toBe(300);
    expect(parentBody.openItems.find((i) => i.kind === "PAYMENT")!.open).toBe(-50);
    expect(parentBody.openItems.reduce((t, i) => t + i.open, 0)).toBe(parentBody.aging.net);
    // The child's invoice is nowhere in the parent's list — a family head rolls nothing up.
    expect(parentBody.openItems.some((i) => i.id === childInvoice.id)).toBe(false);
  });
});
