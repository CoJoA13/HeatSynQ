import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import type { Customer, PaymentType } from "../prisma/generated/prisma/client";

import { GET as getRoute, PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/receivables/batches/[id]/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/receivables/batches/route";
import { POST as addPaymentRoute } from "@/app/api/receivables/batches/[id]/payments/route";
import { DELETE as voidPaymentRoute } from "@/app/api/receivables/batches/[id]/payments/[paymentId]/route";
import { GET as agingRoute } from "@/app/api/receivables/aging/route";
import { GET as agingExportRoute } from "@/app/api/receivables/aging/export/route";
import { GET as statementsRoute, POST as printStatementRoute } from "@/app/api/receivables/statements/route";
import { POST as runStatementsRoute } from "@/app/api/receivables/statements/run/route";
import { GET as statementDocumentsRoute } from "@/app/api/receivables/statements/documents/route";
import { parseDateOnly } from "@/lib/business-days";

// Task 6 (Step 10): thin `handle` wrappers gating on `receivables.create`/`edit`/`delete`/`view` —
// happy-path + 403 for every one of the six service functions' routes.

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
function noBodyReq(url: string, method: string, cookie?: string): Request {
  return new Request(url, { method, headers: cookie ? { cookie } : {} });
}

beforeEach(truncateAll);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `RRC${customerSeq}`, name: `Route Customer ${customerSeq}` } });
}
async function makePaymentType(): Promise<PaymentType> {
  return prisma.paymentType.create({ data: { name: "Check" } });
}

async function createdBatch(cookie: string, controlTotal: number | null = null): Promise<{ id: string }> {
  const res = await createRoute(
    bodyReq("http://t/api/receivables/batches", "POST", cookie, { depositDate: "2026-08-08", controlTotal }),
    withParams({}),
  );
  expect(res.status).toBe(200);
  return res.json();
}

describe("POST /api/receivables/batches", () => {
  it("403s without receivables.create, then creates as OPEN with receivables.create", async () => {
    const wrong = await signInWith(["receivables.view"], "rb-create-wrong");
    expect((await createRoute(
      bodyReq("http://t/api/receivables/batches", "POST", wrong, { depositDate: "2026-08-08", controlTotal: 500 }),
      withParams({}),
    )).status).toBe(403);

    const creator = await signInWith(["receivables.create"], "rb-create-ok");
    const res = await createRoute(
      bodyReq("http://t/api/receivables/batches", "POST", creator, { depositDate: "2026-08-08", controlTotal: 500 }),
      withParams({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("OPEN");
    expect(body.controlTotal).toBe(500);
  });
});

describe("GET /api/receivables/batches", () => {
  it("403s without receivables.view, then lists with it, filterable by status", async () => {
    const creator = await signInWith(["receivables.create", "receivables.edit"], "rb-list-creator");
    const open = await createdBatch(creator);
    const posted = await createdBatch(creator);
    const postRes = await patchRoute(noBodyReq("http://t/api/receivables/batches/x", "PATCH", creator), withParams({ id: posted.id }));
    expect(postRes.status).toBe(200);

    const wrong = await signInWith(["receivables.create"], "rb-list-wrong");
    expect((await listRoute(getReq("http://t/api/receivables/batches", wrong), withParams({}))).status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "rb-list-viewer");
    const all = await listRoute(getReq("http://t/api/receivables/batches", viewer), withParams({}));
    expect(all.status).toBe(200);
    const allIds = (await all.json()).map((r: { id: string }) => r.id);
    expect(allIds).toContain(open.id);
    expect(allIds).toContain(posted.id);

    const openOnly = await listRoute(getReq("http://t/api/receivables/batches?status=OPEN", viewer), withParams({}));
    expect((await openOnly.json()).map((r: { id: string }) => r.id)).toEqual([open.id]);

    const bad = await listRoute(getReq("http://t/api/receivables/batches?status=NOPE", viewer), withParams({}));
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/receivables/batches/[id]", () => {
  it("403s without receivables.view, then reads with it", async () => {
    const creator = await signInWith(["receivables.create"], "rb-get-creator");
    const batch = await createdBatch(creator);

    const wrong = await signInWith(["receivables.create"], "rb-get-wrong");
    expect((await getRoute(getReq("http://t/api/receivables/batches/x", wrong), withParams({ id: batch.id })))
      .status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "rb-get-viewer");
    const res = await getRoute(getReq("http://t/api/receivables/batches/x", viewer), withParams({ id: batch.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(batch.id);
  });
});

describe("PATCH /api/receivables/batches/[id] — post", () => {
  it("403s without receivables.edit, then posts with it", async () => {
    const creator = await signInWith(["receivables.create"], "rb-post-creator");
    const batch = await createdBatch(creator);

    const wrong = await signInWith(["receivables.view"], "rb-post-wrong");
    expect((await patchRoute(noBodyReq("http://t/api/receivables/batches/x", "PATCH", wrong), withParams({ id: batch.id })))
      .status).toBe(403);

    const editor = await signInWith(["receivables.edit"], "rb-post-editor");
    const res = await patchRoute(noBodyReq("http://t/api/receivables/batches/x", "PATCH", editor), withParams({ id: batch.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("POSTED");
  });
});

describe("DELETE /api/receivables/batches/[id] — void", () => {
  it("403s without receivables.delete, then voids an empty batch with a reason", async () => {
    const creator = await signInWith(["receivables.create"], "rb-void-creator");
    const batch = await createdBatch(creator);

    const wrong = await signInWith(["receivables.edit"], "rb-void-wrong");
    expect((await deleteRoute(
      bodyReq("http://t/api/receivables/batches/x", "DELETE", wrong, { reason: "mistake" }),
      withParams({ id: batch.id }),
    )).status).toBe(403);

    const deleter = await signInWith(["receivables.delete"], "rb-void-deleter");
    const res = await deleteRoute(
      bodyReq("http://t/api/receivables/batches/x", "DELETE", deleter, { reason: "duplicate deposit" }),
      withParams({ id: batch.id }),
    );
    expect(res.status).toBe(200);
    const row = await prisma.receiptBatch.findUnique({ where: { id: batch.id } });
    expect(row!.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "receiptBatch", entityId: batch.id, action: "delete" } });
    expect(entry!.reason).toBe("duplicate deposit");
  });
});

describe("POST /api/receivables/batches/[id]/payments", () => {
  it("403s without receivables.create, then adds a payment with it", async () => {
    const creator = await signInWith(["receivables.create"], "rb-pay-creator");
    const batch = await createdBatch(creator, 500);
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const payload = {
      customerId: customer.id, paymentTypeId: paymentType.id, amount: 300,
      reference: "1234", receivedDate: "2026-08-08",
    };

    const wrong = await signInWith(["receivables.view"], "rb-pay-wrong");
    expect((await addPaymentRoute(
      bodyReq("http://t/api/receivables/batches/x/payments", "POST", wrong, payload),
      withParams({ id: batch.id }),
    )).status).toBe(403);

    const res = await addPaymentRoute(
      bodyReq("http://t/api/receivables/batches/x/payments", "POST", creator, payload),
      withParams({ id: batch.id }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enteredTotal).toBe(300);
    expect(body.balance).toBe(200);
    expect(body.payments).toHaveLength(1);
  });
});

describe("DELETE /api/receivables/batches/[id]/payments/[paymentId]", () => {
  it("403s without receivables.delete, then voids the payment with a reason", async () => {
    const creator = await signInWith(["receivables.create"], "rb-voidpay-creator");
    const batch = await createdBatch(creator, 500);
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const addRes = await addPaymentRoute(
      bodyReq("http://t/api/receivables/batches/x/payments", "POST", creator, {
        customerId: customer.id, paymentTypeId: paymentType.id, amount: 300,
        reference: "1234", receivedDate: "2026-08-08",
      }),
      withParams({ id: batch.id }),
    );
    const paymentId = (await addRes.json()).payments[0].id;

    const wrong = await signInWith(["receivables.edit"], "rb-voidpay-wrong");
    expect((await voidPaymentRoute(
      bodyReq("http://t/api/receivables/batches/x/payments/y", "DELETE", wrong, { reason: "mistake" }),
      withParams({ id: batch.id, paymentId }),
    )).status).toBe(403);

    const deleter = await signInWith(["receivables.delete"], "rb-voidpay-deleter");
    const res = await voidPaymentRoute(
      bodyReq("http://t/api/receivables/batches/x/payments/y", "DELETE", deleter, { reason: "wrong customer" }),
      withParams({ id: batch.id, paymentId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payments).toHaveLength(0);
    expect(body.enteredTotal).toBe(0);

    const entry = await prisma.auditLog.findFirst({
      where: { entity: "payment", entityId: paymentId, action: "delete" } });
    expect(entry!.reason).toBe("wrong customer");
  });
});

// -------------------------------------------------------------------------------------------
// Task 10: aging routes — JSON + Excel export, both gated on `receivables.view` (a read, so no
// `create`/`edit`/`delete` gate exists for either).
// -------------------------------------------------------------------------------------------

describe("GET /api/receivables/aging", () => {
  it("403s without receivables.view, then returns the aging rows with it", async () => {
    const wrong = await signInWith(["receivables.create"], "aging-wrong");
    expect((await agingRoute(getReq("http://t/api/receivables/aging", wrong), withParams({}))).status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "aging-viewer");
    const res = await agingRoute(getReq("http://t/api/receivables/aging", viewer), withParams({}));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("404s a customerId naming no live customer", async () => {
    const viewer = await signInWith(["receivables.view"], "aging-404");
    const res = await agingRoute(getReq("http://t/api/receivables/aging?customerId=nope", viewer), withParams({}));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/receivables/aging/export", () => {
  it("403s without receivables.view, then returns an .xlsx with it", async () => {
    const wrong = await signInWith(["receivables.create"], "aging-export-wrong");
    expect((await agingExportRoute(getReq("http://t/api/receivables/aging/export", wrong), withParams({}))).status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "aging-export-viewer");
    const res = await agingExportRoute(getReq("http://t/api/receivables/aging/export", viewer), withParams({}));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toContain("Aging.xlsx");
  });
});

// -------------------------------------------------------------------------------------------
// Task 12: statements — build/print gated receivables.view, the run gated receivables.create.
// -------------------------------------------------------------------------------------------

async function invoicedCustomer(): Promise<{ id: string; code: string }> {
  const customer = await makeCustomer();
  const orderNumber = 900000 + customerSeq;
  const order = await prisma.order.create({
    data: {
      orderNumber, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-06-01"), requestDate: parseDateOnly("2026-06-01"),
    },
  });
  await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly("2026-06-01"), dueDate: parseDateOnly("2026-07-01"),
      total: 500, finalizedAt: parseDateOnly("2026-06-01"),
    },
  });
  return { id: customer.id, code: customer.code };
}

describe("GET /api/receivables/statements", () => {
  it("403s without receivables.view, then builds the statement with it", async () => {
    const customer = await invoicedCustomer();
    const asOf = "2026-08-08";

    const wrong = await signInWith(["receivables.create"], "stmt-get-wrong");
    expect((await statementsRoute(
      getReq(`http://t/api/receivables/statements?customerId=${customer.id}&asOf=${asOf}`, wrong),
      withParams({}),
    )).status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "stmt-get-viewer");
    const res = await statementsRoute(
      getReq(`http://t/api/receivables/statements?customerId=${customer.id}&asOf=${asOf}`, viewer),
      withParams({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customer.code).toBe(customer.code);
    expect(body.totalDue).toBe(500);
  });

  it("400s a missing customerId", async () => {
    const viewer = await signInWith(["receivables.view"], "stmt-get-missing");
    const res = await statementsRoute(getReq("http://t/api/receivables/statements", viewer), withParams({}));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/receivables/statements", () => {
  it("403s without receivables.view, then renders and archives the statement with it", async () => {
    const customer = await invoicedCustomer();
    const payload = { customerId: customer.id, asOf: "2026-08-08" };

    const wrong = await signInWith(["shipping.view"], "stmt-post-wrong");
    expect((await printStatementRoute(
      bodyReq("http://t/api/receivables/statements", "POST", wrong, payload), withParams({}),
    )).status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "stmt-post-viewer");
    const res = await printStatementRoute(
      bodyReq("http://t/api/receivables/statements", "POST", viewer, payload), withParams({}),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const documentId = res.headers.get("x-document-id")!;
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="statement-${customer.code}.pdf"`);

    const stored = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId } });
    expect(stored.kind).toBe("STATEMENT");
    expect(stored.customerId).toBe(customer.id);
  });
});

describe("POST /api/receivables/statements/run", () => {
  it("403s without receivables.create, then prints every customer with a balance with it", async () => {
    await invoicedCustomer();
    const payload = { asOf: "2026-08-08" };

    const wrong = await signInWith(["receivables.view"], "stmt-run-wrong");
    expect((await runStatementsRoute(
      bodyReq("http://t/api/receivables/statements/run", "POST", wrong, payload), withParams({}),
    )).status).toBe(403);

    const creator = await signInWith(["receivables.create"], "stmt-run-creator");
    const res = await runStatementsRoute(
      bodyReq("http://t/api/receivables/statements/run", "POST", creator, payload), withParams({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { customerId: string; documentId: string }[];
    expect(body.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------------------------
// Task 15: statement documents — the customer-scoped STATEMENT history the statements screen
// lists (`listDocumentsForCustomer`, src/server/documents.ts). Gated receivables.view, the
// build/print route's own gate.
// -------------------------------------------------------------------------------------------

describe("GET /api/receivables/statements/documents", () => {
  it("400s a missing customerId", async () => {
    const viewer = await signInWith(["receivables.view"], "stmt-docs-missing");
    const res = await statementDocumentsRoute(
      getReq("http://t/api/receivables/statements/documents", viewer), withParams({}),
    );
    expect(res.status).toBe(400);
  });

  it("403s without receivables.view, then lists the customer's archived statements with it", async () => {
    const customer = await invoicedCustomer();
    const payload = { customerId: customer.id, asOf: "2026-08-08" };

    const wrong = await signInWith(["shipping.view"], "stmt-docs-wrong");
    expect((await statementDocumentsRoute(
      getReq(`http://t/api/receivables/statements/documents?customerId=${customer.id}`, wrong), withParams({}),
    )).status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "stmt-docs-viewer");

    // Nothing archived yet.
    const empty = await statementDocumentsRoute(
      getReq(`http://t/api/receivables/statements/documents?customerId=${customer.id}`, viewer), withParams({}),
    );
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    // Archive one, then it appears.
    const printed = await printStatementRoute(
      bodyReq("http://t/api/receivables/statements", "POST", viewer, payload), withParams({}),
    );
    expect(printed.status).toBe(200);
    const documentId = printed.headers.get("x-document-id");

    const res = await statementDocumentsRoute(
      getReq(`http://t/api/receivables/statements/documents?customerId=${customer.id}`, viewer), withParams({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; kind: string }[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(documentId);
    expect(body[0].kind).toBe("STATEMENT");
  });

  it("404s an unknown customerId", async () => {
    const viewer = await signInWith(["receivables.view"], "stmt-docs-404");
    const res = await statementDocumentsRoute(
      getReq("http://t/api/receivables/statements/documents?customerId=nope", viewer), withParams({}),
    );
    expect(res.status).toBe(404);
  });
});
