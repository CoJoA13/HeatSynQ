import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import type { Customer, PaymentType } from "../prisma/generated/prisma/client";

import { GET as getRoute, PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/receivables/batches/[id]/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/receivables/batches/route";
import { POST as reopenBatchRoute } from "@/app/api/receivables/batches/[id]/reopen/route";
import { POST as addPaymentRoute } from "@/app/api/receivables/batches/[id]/payments/route";
import { DELETE as voidPaymentRoute } from "@/app/api/receivables/batches/[id]/payments/[paymentId]/route";
import { GET as agingRoute } from "@/app/api/receivables/aging/route";
import { GET as agingExportRoute } from "@/app/api/receivables/aging/export/route";
import { GET as statementsRoute, POST as printStatementRoute } from "@/app/api/receivables/statements/route";
import { POST as runStatementsRoute } from "@/app/api/receivables/statements/run/route";
import { GET as statementDocumentsRoute } from "@/app/api/receivables/statements/documents/route";
import { GET as preliminaryRoute } from "@/app/api/receivables/close/preliminary/route";
import { GET as listCloseRoute, POST as closeRoute } from "@/app/api/receivables/close/route";
import { POST as reopenRoute } from "@/app/api/receivables/close/[id]/reopen/route";
import { POST as exportRoute } from "@/app/api/receivables/close/[id]/export/route";
import { GET as exportFileRoute } from "@/app/api/receivables/close/export/[batchId]/file/route";
import { GET as exportRegisterRoute } from "@/app/api/receivables/close/export/[batchId]/register/route";
import { GET as readinessRoute } from "@/app/api/receivables/close/readiness/route";
import { GET as readinessExportRoute } from "@/app/api/receivables/close/readiness/export/route";
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
  it("401s without a session, 403s without receivables.create, then creates as OPEN with receivables.create", async () => {
    expect((await createRoute(
      bodyReq("http://t/api/receivables/batches", "POST", undefined, { depositDate: "2026-08-08", controlTotal: 500 }),
      withParams({}),
    )).status).toBe(401);

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
  it("401s without a session, 403s without receivables.view, then lists with it, filterable by status", async () => {
    expect((await listRoute(getReq("http://t/api/receivables/batches"), withParams({}))).status).toBe(401);

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
  it("401s without a session, 403s without receivables.view, then reads with it", async () => {
    const creator = await signInWith(["receivables.create"], "rb-get-creator");
    const batch = await createdBatch(creator);

    expect((await getRoute(getReq("http://t/api/receivables/batches/x"), withParams({ id: batch.id }))).status).toBe(401);

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
  it("401s without a session, 403s without receivables.edit, then posts with it", async () => {
    const creator = await signInWith(["receivables.create"], "rb-post-creator");
    const batch = await createdBatch(creator);

    expect((await patchRoute(noBodyReq("http://t/api/receivables/batches/x", "PATCH"), withParams({ id: batch.id }))).status).toBe(401);

    const wrong = await signInWith(["receivables.view"], "rb-post-wrong");
    expect((await patchRoute(noBodyReq("http://t/api/receivables/batches/x", "PATCH", wrong), withParams({ id: batch.id })))
      .status).toBe(403);

    const editor = await signInWith(["receivables.edit"], "rb-post-editor");
    const res = await patchRoute(noBodyReq("http://t/api/receivables/batches/x", "PATCH", editor), withParams({ id: batch.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("POSTED");
  });
});

// Issue #68 — POSTED -> OPEN. Same gate as the post it undoes (`receivables.edit`), deliberately:
// reopening is the inverse of an edit, not a delete. The reason is mandatory and reaches the audit
// entry, which is what makes un-settling cash accountable.
describe("POST /api/receivables/batches/[id]/reopen", () => {
  it("401s without a session, 403s without receivables.edit, then reopens a posted batch with a reason", async () => {
    const creator = await signInWith(["receivables.create"], "rb-reopen-creator");
    const batch = await createdBatch(creator);
    const editor = await signInWith(["receivables.edit"], "rb-reopen-editor");
    await patchRoute(noBodyReq("http://t/api/receivables/batches/x", "PATCH", editor), withParams({ id: batch.id }));

    expect((await reopenBatchRoute(
      bodyReq("http://t/api/receivables/batches/x/reopen", "POST", undefined, { reason: "mis-keyed" }),
      withParams({ id: batch.id }),
    )).status).toBe(401);

    const wrong = await signInWith(["receivables.view"], "rb-reopen-wrong");
    expect((await reopenBatchRoute(
      bodyReq("http://t/api/receivables/batches/x/reopen", "POST", wrong, { reason: "mis-keyed" }),
      withParams({ id: batch.id }),
    )).status).toBe(403);

    const res = await reopenBatchRoute(
      bodyReq("http://t/api/receivables/batches/x/reopen", "POST", editor, { reason: "deposit slip did not foot" }),
      withParams({ id: batch.id }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("OPEN");
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "receiptBatch", entityId: batch.id, action: "update" },
      orderBy: { at: "desc" } });
    expect(entry!.reason).toBe("deposit slip did not foot");
  });

  it("400s a blank reason — the service trims, so whitespace cannot masquerade as a justification", async () => {
    const creator = await signInWith(["receivables.create"], "rb-reopen-blank-creator");
    const batch = await createdBatch(creator);
    const editor = await signInWith(["receivables.edit"], "rb-reopen-blank-editor");
    await patchRoute(noBodyReq("http://t/api/receivables/batches/x", "PATCH", editor), withParams({ id: batch.id }));

    const res = await reopenBatchRoute(
      bodyReq("http://t/api/receivables/batches/x/reopen", "POST", editor, { reason: "   " }),
      withParams({ id: batch.id }),
    );
    expect(res.status).toBe(400);
    expect((await prisma.receiptBatch.findUnique({ where: { id: batch.id } }))!.status).toBe("POSTED");
  });
});

describe("DELETE /api/receivables/batches/[id] — void", () => {
  it("401s without a session, 403s without receivables.delete, then voids an empty batch with a reason", async () => {
    const creator = await signInWith(["receivables.create"], "rb-void-creator");
    const batch = await createdBatch(creator);

    expect((await deleteRoute(
      bodyReq("http://t/api/receivables/batches/x", "DELETE", undefined, { reason: "mistake" }),
      withParams({ id: batch.id }),
    )).status).toBe(401);

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
  it("401s without a session, 403s without receivables.create, then adds a payment with it", async () => {
    const creator = await signInWith(["receivables.create"], "rb-pay-creator");
    const batch = await createdBatch(creator, 500);
    const customer = await makeCustomer();
    const paymentType = await makePaymentType();
    const payload = {
      customerId: customer.id, paymentTypeId: paymentType.id, amount: 300,
      reference: "1234", receivedDate: "2026-08-08",
    };

    expect((await addPaymentRoute(
      bodyReq("http://t/api/receivables/batches/x/payments", "POST", undefined, payload),
      withParams({ id: batch.id }),
    )).status).toBe(401);

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
  it("401s without a session, 403s without receivables.delete, then voids the payment with a reason", async () => {
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

    expect((await voidPaymentRoute(
      bodyReq("http://t/api/receivables/batches/x/payments/y", "DELETE", undefined, { reason: "mistake" }),
      withParams({ id: batch.id, paymentId }),
    )).status).toBe(401);

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
  it("401s without a session, 403s without receivables.view, then returns the aging rows with it", async () => {
    expect((await agingRoute(getReq("http://t/api/receivables/aging"), withParams({}))).status).toBe(401);

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
  it("401s without a session, 403s without receivables.view, then returns an .xlsx with it", async () => {
    expect((await agingExportRoute(getReq("http://t/api/receivables/aging/export"), withParams({}))).status).toBe(401);

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

  it("excludes the synthesized family-total row from a family-filtered export (leaf rows only)", async () => {
    // agingReport({customerId: parent}) returns the child's row PLUS a synthesized family-total row
    // keyed on the parent. The export must emit only the leaf (child) rows — matching the SCREEN's
    // body — so summing the exported column doesn't double-count the children (which the family-total
    // row already sums). This is the export analog of the on-screen footer double-count fix.
    const parent = await makeCustomer();
    const child = await prisma.customer.create({
      data: { code: `${parent.code}-DIV`, name: "Division", parentId: parent.id },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: 910000 + customerSeq, customerId: child.id, status: "SHIPPED",
        receivedDate: parseDateOnly("2026-06-01"), requestDate: parseDateOnly("2026-06-01"),
      },
    });
    await prisma.invoice.create({
      data: {
        kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: child.id,
        invoiceDate: parseDateOnly("2026-06-01"), dueDate: parseDateOnly("2026-07-01"), // past due -> nonzero
        total: 200, finalizedAt: parseDateOnly("2026-06-01"),
      },
    });

    const viewer = await signInWith(["receivables.view"], "aging-export-family");
    const res = await agingExportRoute(
      getReq(`http://t/api/receivables/aging/export?customerId=${parent.id}`, viewer),
      withParams({}),
    );
    expect(res.status).toBe(200);

    const wb = new ExcelJS.Workbook();
    // exceljs's `load` param and Node's `Buffer.from(...)` result resolve to two different `Buffer`
    // instantiations under the current @types/node — cast to the exact expected param type.
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const codes: string[] = [];
    wb.worksheets[0].eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header
      codes.push(String(row.getCell(1).value)); // "Customer Code" is the first column
    });

    expect(codes).toContain(child.code);        // the leaf (child) row is exported
    expect(codes).not.toContain(parent.code);   // the synthesized family-total row is NOT
    expect(codes).toHaveLength(1);              // leaf rows only — no double-counting total row
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
  it("401s without a session, 403s without receivables.view, then builds the statement with it", async () => {
    const customer = await invoicedCustomer();
    const asOf = "2026-08-08";

    expect((await statementsRoute(
      getReq(`http://t/api/receivables/statements?customerId=${customer.id}&asOf=${asOf}`),
      withParams({}),
    )).status).toBe(401);

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
  it("401s without a session, 403s without receivables.view, then renders and archives the statement with it", async () => {
    const customer = await invoicedCustomer();
    const payload = { customerId: customer.id, asOf: "2026-08-08" };

    expect((await printStatementRoute(
      bodyReq("http://t/api/receivables/statements", "POST", undefined, payload), withParams({}),
    )).status).toBe(401);

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
  it("401s without a session, 403s without receivables.create, then prints every customer with a balance with it", async () => {
    await invoicedCustomer();
    const payload = { asOf: "2026-08-08" };

    expect((await runStatementsRoute(
      bodyReq("http://t/api/receivables/statements/run", "POST", undefined, payload), withParams({}),
    )).status).toBe(401);

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

  it("401s without a session, 403s without receivables.view, then lists the customer's archived statements with it", async () => {
    const customer = await invoicedCustomer();
    const payload = { customerId: customer.id, asOf: "2026-08-08" };

    expect((await statementDocumentsRoute(
      getReq(`http://t/api/receivables/statements/documents?customerId=${customer.id}`), withParams({}),
    )).status).toBe(401);

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

// -------------------------------------------------------------------------------------------
// Task 5 (P5C §4.1): the close lifecycle routes — preliminary (receivables.view), close and reopen
// (receivables.edit + the `close_ar_period` special). The 401/403/200 ladder, plus a
// `close_ar_period`-missing 403 (the caller has receivables.edit but not the dangerous special).
// -------------------------------------------------------------------------------------------

async function finalizedInvoiceDated(dateStr: string, total: number): Promise<void> {
  const customer = await makeCustomer();
  const order = await prisma.order.create({
    data: {
      orderNumber: 770000 + customerSeq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly(dateStr), requestDate: parseDateOnly(dateStr),
    },
  });
  await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly(dateStr), dueDate: parseDateOnly(dateStr),
      total, finalizedAt: parseDateOnly(dateStr),
    },
  });
}

describe("GET /api/receivables/close/preliminary", () => {
  it("401s without a session, 403s without receivables.view, then returns the schedule with it", async () => {
    await finalizedInvoiceDated("2026-07-05", 100);
    const url = "http://t/api/receivables/close/preliminary?year=2026&month=7";

    expect((await preliminaryRoute(getReq(url), withParams({}))).status).toBe(401);

    const wrong = await signInWith(["receivables.create"], "close-prelim-wrong");
    expect((await preliminaryRoute(getReq(url, wrong), withParams({}))).status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "close-prelim-viewer");
    const res = await preliminaryRoute(getReq(url, viewer), withParams({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.year).toBe(2026);
    expect(body.month).toBe(7);
    expect(body.schedule.endingAr).toBe(100);
    expect(body.alreadyClosed).toBe(false);
  });

  it("400s a missing month", async () => {
    const viewer = await signInWith(["receivables.view"], "close-prelim-missing");
    const res = await preliminaryRoute(
      getReq("http://t/api/receivables/close/preliminary?year=2026", viewer), withParams({}),
    );
    expect(res.status).toBe(400);
  });

  it("400s a year below 2000 (the Date.UTC 0-99 -> 1900-1999 remap guard)", async () => {
    const viewer = await signInWith(["receivables.view"], "close-prelim-yr");
    const res = await preliminaryRoute(
      getReq("http://t/api/receivables/close/preliminary?year=26&month=7", viewer), withParams({}),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/receivables/close", () => {
  it("401s without a session, 403s without close_ar_period, then closes with receivables.edit + close_ar_period", async () => {
    await finalizedInvoiceDated("2026-07-05", 100);
    const payload = { year: 2026, month: 7 };

    expect((await closeRoute(
      bodyReq("http://t/api/receivables/close", "POST", undefined, payload), withParams({}),
    )).status).toBe(401);

    // Has receivables.edit but NOT the close_ar_period special — the dangerous action is refused.
    const wrong = await signInWith(["receivables.edit"], "close-post-wrong");
    expect((await closeRoute(
      bodyReq("http://t/api/receivables/close", "POST", wrong, payload), withParams({}),
    )).status).toBe(403);

    const closer = await signInWith(["receivables.edit", "action.close_ar_period"], "close-post-ok");
    const res = await closeRoute(
      bodyReq("http://t/api/receivables/close", "POST", closer, payload), withParams({}),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("CLOSED");
    expect(body.endingAr).toBe(100);
  });

  it("400s a year below 2000 (the Date.UTC 0-99 -> 1900-1999 remap guard)", async () => {
    const closer = await signInWith(["receivables.edit", "action.close_ar_period"], "close-post-yr");
    const res = await closeRoute(
      bodyReq("http://t/api/receivables/close", "POST", closer, { year: 26, month: 7 }), withParams({}),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/receivables/close", () => {
  it("401s without a session, 403s without receivables.view, then lists closed periods with their frozen figures and export batches", async () => {
    const closer = await signInWith(["receivables.edit", "action.close_ar_period", "action.run_qbo_export"], "close-list-closer");
    const periodId = await glReadyClosedJuly(closer);
    const batch = await (await exportRoute(
      noBodyReq("http://t/api/receivables/close/x/export", "POST", closer), withParams({ id: periodId }),
    )).json() as { batchId: string };

    expect((await listCloseRoute(getReq("http://t/api/receivables/close"), withParams({}))).status).toBe(401);

    const wrong = await signInWith(["receivables.create"], "close-list-wrong");
    expect((await listCloseRoute(getReq("http://t/api/receivables/close", wrong), withParams({}))).status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "close-list-viewer");
    const res = await listCloseRoute(getReq("http://t/api/receivables/close", viewer), withParams({}));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      id: string; year: number; month: number; status: string; endingAr: number;
      exportBatches: { id: string; exportNumber: number; fileName: string }[];
    }[];
    const row = body.find((r) => r.id === periodId);
    expect(row).toBeTruthy();
    expect(row!.year).toBe(2026);
    expect(row!.month).toBe(7);
    expect(row!.status).toBe("CLOSED");
    expect(row!.endingAr).toBe(100);
    expect(row!.exportBatches.map((b) => b.id)).toContain(batch.batchId);
    expect(row!.exportBatches[0].fileName).toBe("gl-2026-07.csv");
  });
});

describe("POST /api/receivables/close/[id]/reopen", () => {
  it("401s without a session, 403s without close_ar_period, then reopens with it (reason required)", async () => {
    await finalizedInvoiceDated("2026-07-05", 100);
    const closer = await signInWith(["receivables.edit", "action.close_ar_period"], "reopen-closer");
    const closed = await (await closeRoute(
      bodyReq("http://t/api/receivables/close", "POST", closer, { year: 2026, month: 7 }), withParams({}),
    )).json();

    const payload = { reason: "correcting a mis-keyed invoice" };

    expect((await reopenRoute(
      bodyReq("http://t/api/receivables/close/x/reopen", "POST", undefined, payload),
      withParams({ id: closed.id }),
    )).status).toBe(401);

    const wrong = await signInWith(["receivables.edit"], "reopen-wrong");
    expect((await reopenRoute(
      bodyReq("http://t/api/receivables/close/x/reopen", "POST", wrong, payload),
      withParams({ id: closed.id }),
    )).status).toBe(403);

    // Reason required (service rule) surfaces as a 400 through the route.
    const empty = await reopenRoute(
      bodyReq("http://t/api/receivables/close/x/reopen", "POST", closer, { reason: "  " }),
      withParams({ id: closed.id }),
    );
    expect(empty.status).toBe(400);

    const res = await reopenRoute(
      bodyReq("http://t/api/receivables/close/x/reopen", "POST", closer, payload),
      withParams({ id: closed.id }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("REOPENED");
  });
});

// -------------------------------------------------------------------------------------------
// Task 6 (P5C §4.3/§7): the GL-export + readiness routes. Export is the dangerous `run_qbo_export`
// special on top of `receivables.edit`; the file/readiness/readiness-export reads are all
// `receivables.view`. The ladders assert the file route's text/csv and the readiness export's xlsx
// MIME, plus the period-scoping (`?year=&month=`) that keeps the panel aligned with the refusal.
// -------------------------------------------------------------------------------------------

/** A GL-ready CLOSED July: BillingConfig A/R set (the only account any event resolves to), a
 *  finalized July invoice with one revenue line — so `exportClose` finds no readiness gap. Returns
 *  the closed period id. */
async function glReadyClosedJuly(closer: string): Promise<string> {
  customerSeq += 1;
  const ar = await prisma.glAccount.create({ data: { name: `AR-${customerSeq}` } });
  const rev = await prisma.glAccount.create({ data: { name: `REV-${customerSeq}` } });
  const step = await prisma.processStepCode.create({
    data: { code: `HT${customerSeq}`, name: "Heat Treat", glAccountId: rev.id },
  });
  await prisma.billingConfig.update({
    where: { id: "singleton" },
    data: { arGlAccountId: ar.id, salesTaxGlAccountId: null, discountGlAccountId: null, writeOffGlAccountId: null },
  });
  const customer = await makeCustomer();
  const order = await prisma.order.create({
    data: {
      orderNumber: 780000 + customerSeq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-07-05"), requestDate: parseDateOnly("2026-07-05"),
    },
  });
  await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "FINALIZED", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly("2026-07-05"), dueDate: parseDateOnly("2026-07-05"),
      total: 100, subtotal: 100, finalizedAt: parseDateOnly("2026-07-05"),
      lines: {
        create: [{
          position: 1, kind: "OPERATION", processStepCodeId: step.id,
          glAccountId: rev.id, glAccountName: `REV-${customerSeq}`, description: "Heat Treat", amount: 100,
        }],
      },
    },
  });
  const closed = await (await closeRoute(
    bodyReq("http://t/api/receivables/close", "POST", closer, { year: 2026, month: 7 }), withParams({}),
  )).json();
  return closed.id;
}

describe("POST /api/receivables/close/[id]/export", () => {
  it("401s without a session, 403s without run_qbo_export, then emits a balanced batch with it", async () => {
    const closer = await signInWith(["receivables.edit", "action.close_ar_period"], "export-closer");
    const periodId = await glReadyClosedJuly(closer);

    expect((await exportRoute(
      noBodyReq("http://t/api/receivables/close/x/export", "POST"), withParams({ id: periodId }),
    )).status).toBe(401);

    // Has receivables.edit but NOT the run_qbo_export special — the dangerous action is refused.
    const wrong = await signInWith(["receivables.edit"], "export-wrong");
    expect((await exportRoute(
      noBodyReq("http://t/api/receivables/close/x/export", "POST", wrong), withParams({ id: periodId }),
    )).status).toBe(403);

    const exporter = await signInWith(["receivables.edit", "action.run_qbo_export"], "export-ok");
    const res = await exportRoute(
      noBodyReq("http://t/api/receivables/close/x/export", "POST", exporter), withParams({ id: periodId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { batchId: string; postings: { debit: number; credit: number }[] };
    expect(body.batchId).toBeTruthy();
    const debit = body.postings.reduce((s, p) => s + p.debit, 0);
    const credit = body.postings.reduce((s, p) => s + p.credit, 0);
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100));
  });
});

describe("GET /api/receivables/close/export/[batchId]/file", () => {
  it("401s without a session, 403s without receivables.view, then streams the CSV as text/csv with it", async () => {
    const closer = await signInWith(["receivables.edit", "action.close_ar_period", "action.run_qbo_export"], "file-closer");
    const periodId = await glReadyClosedJuly(closer);
    const batch = await (await exportRoute(
      noBodyReq("http://t/api/receivables/close/x/export", "POST", closer), withParams({ id: periodId }),
    )).json() as { batchId: string };

    expect((await exportFileRoute(
      getReq("http://t/api/receivables/close/export/x/file"), withParams({ batchId: batch.batchId }),
    )).status).toBe(401);

    const wrong = await signInWith(["receivables.create"], "file-wrong");
    expect((await exportFileRoute(
      getReq("http://t/api/receivables/close/export/x/file", wrong), withParams({ batchId: batch.batchId }),
    )).status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "file-viewer");
    const res = await exportFileRoute(
      getReq("http://t/api/receivables/close/export/x/file", viewer), withParams({ batchId: batch.batchId }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(res.headers.get("content-disposition")).toContain("gl-2026-07.csv");
  });

  it("404s an unknown batch id (viewer)", async () => {
    const viewer = await signInWith(["receivables.view"], "file-404");
    const res = await exportFileRoute(
      getReq("http://t/api/receivables/close/export/x/file", viewer), withParams({ batchId: "nope" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/receivables/close/export/[batchId]/register", () => {
  it("401s without a session, 403s without receivables.view, then streams the posting register as application/pdf with it", async () => {
    const closer = await signInWith(["receivables.edit", "action.close_ar_period", "action.run_qbo_export"], "register-closer");
    const periodId = await glReadyClosedJuly(closer);
    const batch = await (await exportRoute(
      noBodyReq("http://t/api/receivables/close/x/export", "POST", closer), withParams({ id: periodId }),
    )).json() as { batchId: string };

    expect((await exportRegisterRoute(
      getReq("http://t/api/receivables/close/export/x/register"), withParams({ batchId: batch.batchId }),
    )).status).toBe(401);

    const wrong = await signInWith(["receivables.create"], "register-wrong");
    expect((await exportRegisterRoute(
      getReq("http://t/api/receivables/close/export/x/register", wrong), withParams({ batchId: batch.batchId }),
    )).status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "register-viewer");
    const res = await exportRegisterRoute(
      getReq("http://t/api/receivables/close/export/x/register", viewer), withParams({ batchId: batch.batchId }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="gl-register-2026-07.pdf"');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(bytes.toString("latin1")).toContain("/Count 1"); // uncompressed page marker, bol.test.ts's rule
  });

  it("404s an unknown batch id (viewer)", async () => {
    const viewer = await signInWith(["receivables.view"], "register-404");
    const res = await exportRegisterRoute(
      getReq("http://t/api/receivables/close/export/x/register", viewer), withParams({ batchId: "nope" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/receivables/close/readiness", () => {
  it("401s without a session, 403s without receivables.view, then returns the gap list for the period", async () => {
    const url = "http://t/api/receivables/close/readiness?year=2026&month=7";

    expect((await readinessRoute(getReq(url), withParams({}))).status).toBe(401);

    const wrong = await signInWith(["receivables.create"], "readiness-wrong");
    expect((await readinessRoute(getReq(url, wrong), withParams({}))).status).toBe(403);

    // A finalized July invoice but NO A/R account configured -> the A/R control gap is named.
    await finalizedInvoiceDated("2026-07-05", 100);
    await prisma.billingConfig.update({ where: { id: "singleton" }, data: { arGlAccountId: null } });

    const viewer = await signInWith(["receivables.view"], "readiness-viewer");
    const res = await readinessRoute(getReq(url, viewer), withParams({}));
    expect(res.status).toBe(200);
    const gaps = await res.json() as { label: string }[];
    expect(gaps.some((g) => /A\/R/i.test(g.label))).toBe(true);
  });

  it("400s a missing month", async () => {
    const viewer = await signInWith(["receivables.view"], "readiness-missing");
    const res = await readinessRoute(
      getReq("http://t/api/receivables/close/readiness?year=2026", viewer), withParams({}),
    );
    expect(res.status).toBe(400);
  });

  it("400s a missing year (Number(null)=0 must NOT slip through as 1900)", async () => {
    const viewer = await signInWith(["receivables.view"], "readiness-missing-year");
    const res = await readinessRoute(
      getReq("http://t/api/receivables/close/readiness?month=7", viewer), withParams({}),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/receivables/close/readiness/export", () => {
  it("401s without a session, 403s without receivables.view, then returns an .xlsx with it", async () => {
    const url = "http://t/api/receivables/close/readiness/export?year=2026&month=7";

    expect((await readinessExportRoute(getReq(url), withParams({}))).status).toBe(401);

    const wrong = await signInWith(["receivables.create"], "readiness-export-wrong");
    expect((await readinessExportRoute(getReq(url, wrong), withParams({}))).status).toBe(403);

    const viewer = await signInWith(["receivables.view"], "readiness-export-viewer");
    const res = await readinessExportRoute(getReq(url, viewer), withParams({}));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toContain("Readiness.xlsx");
  });
});
