import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import type { Customer, PaymentType } from "../prisma/generated/prisma/client";

import { GET as getRoute, PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/receivables/batches/[id]/route";
import { POST as createRoute } from "@/app/api/receivables/batches/route";
import { POST as addPaymentRoute } from "@/app/api/receivables/batches/[id]/payments/route";
import { DELETE as voidPaymentRoute } from "@/app/api/receivables/batches/[id]/payments/[paymentId]/route";

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
