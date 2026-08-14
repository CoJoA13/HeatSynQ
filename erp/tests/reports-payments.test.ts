import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import {
  buildPayments, reportPayments, PAYMENTS_BASIS,
  type PaymentRow, type PaymentGroupRow, type PaymentDetailRow,
} from "@/server/reports/payments";
import { GET as paymentsRoute } from "@/app/api/reports/payments/route";
import { GET as paymentsExportRoute } from "@/app/api/reports/payments/export/route";
import { parseDateOnly } from "@/lib/business-days";

// Phase 8A Task 5 (spec §4.2): the Payments-received report — cash received by period, sliceable by
// customer / month (of receivedDate) / payment type. The load-bearing measure:
//   • Population is POSTED-batch payments ONLY — a Payment counts iff its ReceiptBatch.status =
//     POSTED (the books-consistent basis, matching deposits and the month-end close; aging's
//     "all payments" basis is deliberately NOT used). `deletedAt: null` on both the payment and the
//     batch. A payment sitting in an OPEN batch is un-posted cash and must NOT appear.
//   • The date anchor is `receivedDate` (@db.Date — no time-of-day), inclusive `[from, to]`.
//   • There is deliberately NO "by part" slice — a payment pays invoices, not parts.
// `buildPayments` is the pure core (grouping + summing, unit-testable); `reportPayments` is the thin
// Prisma-reading wrapper that applies the POSTED filter. A report is a pure read (no claim, no
// audit).

beforeEach(truncateAll);

let seq = 0;

const withParams = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

// ---------------------------------------------------------------------------------------------
// Pure core — buildPayments. No DB.
// ---------------------------------------------------------------------------------------------

function pay(over: Partial<PaymentRow> = {}): PaymentRow {
  seq += 1;
  return {
    paymentId: `pay-${seq}`, reference: `CHK-${seq}`,
    customerId: "c1", customerCode: "C1", customerName: "Customer One",
    paymentTypeId: "pt1", paymentTypeName: "Check",
    receivedDate: "2026-08-01", amount: 100, ...over,
  };
}

describe("buildPayments — detail grain", () => {
  it("emits one row per payment, sorted by received date then customer, with the total + basis", () => {
    const rows = [
      pay({ paymentId: "A", receivedDate: "2026-08-05", amount: 100 }),
      pay({ paymentId: "B", receivedDate: "2026-08-01", amount: 50 }),
    ];
    const result = buildPayments(rows, { groupBy: "none" });
    expect(result.groupBy).toBe("none");
    const detail = result.rows as PaymentDetailRow[];
    expect(detail.map((r) => r.receivedDate)).toEqual(["2026-08-01", "2026-08-05"]); // B before A
    expect(result.total).toBe(150);
    expect(result.paymentCount).toBe(2);
    expect(result.basis).toBe(PAYMENTS_BASIS);
  });

  it("sums fractional dollars in integer cents so they don't drift", () => {
    const rows = [pay({ amount: 0.1 }), pay({ amount: 0.2 })];
    expect(buildPayments(rows, { groupBy: "none" }).total).toBe(0.3);
  });
});

describe("buildPayments — grouping", () => {
  it("by customer: distinct customers, payment count + Σ amount", () => {
    const rows = [
      pay({ customerId: "cA", customerCode: "AAA", customerName: "Alpha", amount: 100 }),
      pay({ customerId: "cA", customerCode: "AAA", customerName: "Alpha", amount: 25 }),
      pay({ customerId: "cB", customerCode: "BBB", customerName: "Beta", amount: 50 }),
    ];
    const grouped = buildPayments(rows, { groupBy: "customer" }).rows as PaymentGroupRow[];
    const alpha = grouped.find((r) => r.key === "cA")!;
    expect(alpha.amount).toBe(125);
    expect(alpha.paymentCount).toBe(2);
    expect(grouped.find((r) => r.key === "cB")!.amount).toBe(50);
  });

  it("by month: groups on the yyyy-mm of receivedDate, chronological", () => {
    const rows = [
      pay({ receivedDate: "2026-07-15", amount: 100 }),
      pay({ receivedDate: "2026-07-20", amount: 30 }),
      pay({ receivedDate: "2026-08-02", amount: 50 }),
    ];
    const grouped = buildPayments(rows, { groupBy: "month" }).rows as PaymentGroupRow[];
    expect(grouped.map((r) => r.key)).toEqual(["2026-07", "2026-08"]);
    expect(grouped.find((r) => r.key === "2026-07")!.amount).toBe(130);
    expect(grouped.find((r) => r.key === "2026-07")!.paymentCount).toBe(2);
  });

  it("by payment type: groups on the payment type", () => {
    const rows = [
      pay({ paymentTypeId: "ptCheck", paymentTypeName: "Check", amount: 100 }),
      pay({ paymentTypeId: "ptCheck", paymentTypeName: "Check", amount: 40 }),
      pay({ paymentTypeId: "ptWire", paymentTypeName: "Wire", amount: 60 }),
    ];
    const grouped = buildPayments(rows, { groupBy: "type" }).rows as PaymentGroupRow[];
    expect(grouped.find((r) => r.key === "ptCheck")!.amount).toBe(140);
    expect(grouped.find((r) => r.key === "ptCheck")!.label).toBe("Check");
    expect(grouped.find((r) => r.key === "ptWire")!.amount).toBe(60);
    // a slice total equals the unsliced total
    expect(grouped.reduce((s, r) => s + r.amount, 0)).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Service wiring — reportPayments reads the DB. The load-bearing POSTED-only filter lives here.
// ---------------------------------------------------------------------------------------------

let batchSeq = 0;
async function makeCustomer(code?: string): Promise<{ id: string; code: string; name: string }> {
  seq += 1;
  return prisma.customer.create({ data: { code: code ?? `PAY${seq}`, name: `Pay Cust ${seq}` } });
}
async function makePaymentType(name?: string): Promise<{ id: string; name: string }> {
  seq += 1;
  return prisma.paymentType.create({ data: { name: name ?? `PT-${seq}` } });
}

/** Seed one payment in a batch of the given status. Returns the payment's reference so a test can
 *  assert its presence/absence in the report. */
async function makePayment(opts: {
  customerId: string;
  paymentTypeId: string;
  amount: number;
  receivedDate: string;
  batchStatus?: "OPEN" | "POSTED";
  batchDeletedAt?: Date;
  paymentDeletedAt?: Date;
  reference?: string;
}): Promise<string> {
  batchSeq += 1;
  const reference = opts.reference ?? `REF-${batchSeq}`;
  const batch = await prisma.receiptBatch.create({
    data: {
      batchNumber: 860000 + batchSeq,
      depositDate: parseDateOnly(opts.receivedDate),
      status: opts.batchStatus ?? "POSTED",
      deletedAt: opts.batchDeletedAt ?? null,
    },
  });
  await prisma.payment.create({
    data: {
      batchId: batch.id, customerId: opts.customerId, paymentTypeId: opts.paymentTypeId,
      amount: opts.amount, reference, receivedDate: parseDateOnly(opts.receivedDate),
      deletedAt: opts.paymentDeletedAt ?? null,
    },
  });
  return reference;
}

describe("reportPayments — POSTED batches only (the load-bearing filter)", () => {
  it("counts a POSTED-batch payment but NOT one sitting in an OPEN batch", async () => {
    const cust = await makeCustomer();
    const pt = await makePaymentType();
    const posted = await makePayment({
      customerId: cust.id, paymentTypeId: pt.id, amount: 100, receivedDate: "2026-08-01",
      batchStatus: "POSTED", reference: "POSTED-1",
    });
    const open = await makePayment({
      customerId: cust.id, paymentTypeId: pt.id, amount: 999, receivedDate: "2026-08-01",
      batchStatus: "OPEN", reference: "OPEN-1",
    });

    const result = await reportPayments({});
    expect(result.total).toBe(100); // the OPEN batch's 999 is un-posted cash — excluded
    expect(result.paymentCount).toBe(1);
    const refs = (result.rows as PaymentDetailRow[]).map((r) => r.reference);
    expect(refs).toContain(posted);
    expect(refs).not.toContain(open);
    expect(result.basis).toBe(PAYMENTS_BASIS);
    expect(await prisma.auditLog.count()).toBe(0); // a report is a pure read
  });

  it("excludes a payment whose POSTED batch was voided (batch deletedAt), and a voided payment", async () => {
    const cust = await makeCustomer();
    const pt = await makePaymentType();
    await makePayment({
      customerId: cust.id, paymentTypeId: pt.id, amount: 100, receivedDate: "2026-08-01",
      batchStatus: "POSTED",
    });
    await makePayment({
      customerId: cust.id, paymentTypeId: pt.id, amount: 200, receivedDate: "2026-08-01",
      batchStatus: "POSTED", batchDeletedAt: new Date(),
    });
    await makePayment({
      customerId: cust.id, paymentTypeId: pt.id, amount: 300, receivedDate: "2026-08-01",
      batchStatus: "POSTED", paymentDeletedAt: new Date(),
    });
    const result = await reportPayments({});
    expect(result.total).toBe(100);
    expect(result.paymentCount).toBe(1);
  });
});

describe("reportPayments — receivedDate range (inclusive both ends)", () => {
  it("keeps payments on the boundary dates and drops those outside", async () => {
    const cust = await makeCustomer();
    const pt = await makePaymentType();
    await makePayment({ customerId: cust.id, paymentTypeId: pt.id, amount: 10, receivedDate: "2026-07-31" });
    await makePayment({ customerId: cust.id, paymentTypeId: pt.id, amount: 20, receivedDate: "2026-08-01" });
    await makePayment({ customerId: cust.id, paymentTypeId: pt.id, amount: 40, receivedDate: "2026-08-31" });
    await makePayment({ customerId: cust.id, paymentTypeId: pt.id, amount: 80, receivedDate: "2026-09-01" });

    const inAug = await reportPayments({ from: "2026-08-01", to: "2026-08-31" });
    expect(inAug.total).toBe(60); // 20 (1st) + 40 (31st), inclusive both ends
    expect(inAug.paymentCount).toBe(2);

    // a blank filter narrows nothing
    expect((await reportPayments({})).total).toBe(150);
  });
});

describe("reportPayments — grouping over real rows", () => {
  it("by customer / month / payment type each aggregate correctly", async () => {
    const custA = await makeCustomer("CUSTA");
    const custB = await makeCustomer("CUSTB");
    const check = await makePaymentType("Check");
    const wire = await makePaymentType("Wire");
    await makePayment({ customerId: custA.id, paymentTypeId: check.id, amount: 100, receivedDate: "2026-07-10" });
    await makePayment({ customerId: custA.id, paymentTypeId: wire.id, amount: 50, receivedDate: "2026-08-10" });
    await makePayment({ customerId: custB.id, paymentTypeId: check.id, amount: 25, receivedDate: "2026-08-20" });

    const byCust = (await reportPayments({ groupBy: "customer" })).rows as PaymentGroupRow[];
    expect(byCust.find((r) => r.key === custA.id)!.amount).toBe(150);
    expect(byCust.find((r) => r.key === custB.id)!.amount).toBe(25);

    const byMonth = (await reportPayments({ groupBy: "month" })).rows as PaymentGroupRow[];
    expect(byMonth.find((r) => r.key === "2026-07")!.amount).toBe(100);
    expect(byMonth.find((r) => r.key === "2026-08")!.amount).toBe(75);

    const byType = (await reportPayments({ groupBy: "type" })).rows as PaymentGroupRow[];
    expect(byType.find((r) => r.key === check.id)!.amount).toBe(125);
    expect(byType.find((r) => r.key === wire.id)!.amount).toBe(50);
  });

  it("400s a malformed date bound and an unknown groupBy", async () => {
    await expect(reportPayments({ from: "not-a-date" })).rejects.toMatchObject({ status: 400 });
    await expect(reportPayments({ groupBy: "part" as never })).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------------------------
// Route gate + export attachment (with the basis printed into the workbook).
// ---------------------------------------------------------------------------------------------

describe("GET /api/reports/payments", () => {
  it("401s without a session, 403s without reports.view, 200s with it and carries the basis", async () => {
    expect((await paymentsRoute(getReq("http://t/api/reports/payments"), withParams())).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "pay-wrong");
    expect((await paymentsRoute(getReq("http://t/api/reports/payments", wrong), withParams())).status).toBe(403);

    const viewer = await signInWith(["reports.view"], "pay-viewer");
    const res = await paymentsRoute(getReq("http://t/api/reports/payments", viewer), withParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.basis).toBe(PAYMENTS_BASIS);
  });
});

describe("GET /api/reports/payments/export", () => {
  it("requires reports.view and returns an xlsx attachment that prints the basis", async () => {
    expect((await paymentsExportRoute(getReq("http://t/api/reports/payments/export"), withParams())).status).toBe(401);

    const viewer = await signInWith(["reports.view"], "pay-export-viewer");
    const res = await paymentsExportRoute(getReq("http://t/api/reports/payments/export", viewer), withParams());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain("Payments.xlsx");

    // The basis is printed into the sheet itself (caption above the header), so un-posted cash is
    // never mistaken for missing money by whoever opens the file.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Payments")!;
    expect(sheet.getCell("A1").value).toBe(PAYMENTS_BASIS);
  });
});
