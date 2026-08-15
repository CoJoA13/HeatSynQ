import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { closePeriod } from "@/server/close-periods";
import { exportClose } from "@/server/gl-export";
import {
  buildSales, reportSales,
  type SalesLine, type SalesGroupRow, type SalesDetailRow,
} from "@/server/reports/sales";
import { GET as salesRoute } from "@/app/api/reports/sales/route";
import { GET as salesExportRoute } from "@/app/api/reports/sales/export/route";
import { parseDateOnly } from "@/lib/business-days";
import type { InvoiceLineKindValue } from "@/lib/invoice-constants";

// Phase 8A Task 4 (spec §4.2 / §8): the Sales report — invoiced revenue EXCLUDING sales tax, net
// of credits, sliceable by customer / part / finalized-month and reconciling to the GL export's
// revenue accounts. The two things the plan flags hardest:
//   • SURCHARGE carries REAL revenue and a BLANK partNumber (pricing.ts `blank("SURCHARGE")`) — it
//     must be summed (dropping it undercounts sales and breaks reconciliation) and, in the by-part
//     cut, it falls into an explicit "(no part)" bucket, never re-joined to the part it surcharges.
//   • The report reads the FROZEN Invoice/InvoiceLine snapshot by `finalizedAt` — NEVER a live join
//     to Part/StepCode, and NEVER `invoiceDate`.
// `buildSales` is the pure core (ex-tax + "(no part)" bucketing live here, unit-testable); the DB
// wrapper `reportSales` only assembles the frozen snapshot into `SalesLine`s. A report is a pure
// read (no claim, no audit).

beforeEach(truncateAll);

let seq = 0;

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

// ---------------------------------------------------------------------------------------------
// Pure core — buildSales. No DB.
// ---------------------------------------------------------------------------------------------

function line(over: Partial<SalesLine> = {}): SalesLine {
  seq += 1;
  return {
    invoiceId: `inv-${seq}`, documentNumber: `D-${seq}`, documentKind: "INVOICE",
    lineKind: "OPERATION",
    customerId: "c1", customerCode: "C1", customerName: "Customer One",
    finalizedDate: "2026-08-01",
    partNumber: "PN-1", partName: "Widget",
    amount: 100, ...over,
  };
}

describe("buildSales — detail grain", () => {
  it("emits one row per document, summing its non-tax lines, sorted by finalized date then document", () => {
    const lines = [
      line({ invoiceId: "A", documentNumber: "A", finalizedDate: "2026-08-05", lineKind: "PART", amount: 0 }),
      line({ invoiceId: "A", documentNumber: "A", finalizedDate: "2026-08-05", lineKind: "OPERATION", amount: 100 }),
      line({ invoiceId: "B", documentNumber: "B", finalizedDate: "2026-08-01", lineKind: "OPERATION", amount: 50 }),
    ];
    const result = buildSales(lines, { groupBy: "none" });
    expect(result.groupBy).toBe("none");
    const rows = result.rows as SalesDetailRow[];
    expect(rows.map((r) => r.finalizedDate)).toEqual(["2026-08-01", "2026-08-05"]); // B before A
    expect(rows.find((r) => r.invoiceId === "A")!.revenue).toBe(100); // PART header (0) + OPERATION (100)
    expect(rows.find((r) => r.invoiceId === "B")!.revenue).toBe(50);
    expect(result.total).toBe(150);
    expect(result.invoiceCount).toBe(2);
  });
});

describe("buildSales — excludes sales tax (ex-tax)", () => {
  it("drops the TAX line from the document revenue and the grand total", () => {
    const lines = [
      line({ invoiceId: "A", documentNumber: "A", lineKind: "OPERATION", amount: 100 }),
      line({ invoiceId: "A", documentNumber: "A", lineKind: "TAX", partNumber: "", amount: 8 }),
    ];
    const result = buildSales(lines, { groupBy: "none" });
    expect(result.total).toBe(100); // NOT 108
    expect((result.rows as SalesDetailRow[])[0].revenue).toBe(100);
  });
});

describe("buildSales — SURCHARGE (real revenue, blank part)", () => {
  it("includes the surcharge in the grand total and buckets it under '(no part)'", () => {
    const lines = [
      line({ invoiceId: "A", documentNumber: "A", lineKind: "PART", partNumber: "P", partName: "Widget", amount: 0 }),
      line({ invoiceId: "A", documentNumber: "A", lineKind: "OPERATION", partNumber: "P", partName: "Widget", amount: 100 }),
      line({ invoiceId: "A", documentNumber: "A", lineKind: "SURCHARGE", partNumber: "", amount: 15 }),
    ];
    const none = buildSales(lines, { groupBy: "none" });
    expect(none.total).toBe(115); // surcharge revenue is real — it must be counted

    const part = buildSales(lines, { groupBy: "part" });
    const rows = part.rows as SalesGroupRow[];
    const pRow = rows.find((r) => r.key === "c1 P")!;
    expect(pRow.revenue).toBe(100); // the part gets its operation, NOT the surcharge
    const noPart = rows.find((r) => r.key === "(no part)")!;
    expect(noPart).toBeDefined();
    expect(noPart.label).toBe("(no part)");
    expect(noPart.revenue).toBe(15); // the surcharge lands here — never re-joined to the part
    // sliced total == unsliced total
    expect(rows.reduce((s, r) => s + r.revenue, 0)).toBe(none.total);
  });
});

describe("buildSales — credits net down the total", () => {
  it("subtracts a CREDIT document's (negative) lines", () => {
    const lines = [
      line({ invoiceId: "A", documentKind: "INVOICE", documentNumber: "A", lineKind: "OPERATION", amount: 100 }),
      line({ invoiceId: "C", documentKind: "CREDIT", documentNumber: "CR-1", lineKind: "OPERATION", amount: -30 }),
    ];
    const result = buildSales(lines, { groupBy: "none" });
    expect(result.total).toBe(70);
    const rows = result.rows as SalesDetailRow[];
    const credit = rows.find((r) => r.invoiceId === "C")!;
    expect(credit.kind).toBe("CREDIT");
    expect(credit.revenue).toBe(-30);
  });
});

describe("buildSales — grouping", () => {
  it("by part: parts are customer-scoped, and blank-part lines share one '(no part)' bucket", () => {
    const lines = [
      line({ invoiceId: "A", customerId: "cA", customerCode: "AAA", customerName: "Alpha", lineKind: "OPERATION", partNumber: "PN-1", amount: 100 }),
      line({ invoiceId: "A", customerId: "cA", customerCode: "AAA", customerName: "Alpha", lineKind: "SURCHARGE", partNumber: "", amount: 10 }),
      line({ invoiceId: "B", customerId: "cB", customerCode: "BBB", customerName: "Beta", lineKind: "OPERATION", partNumber: "PN-1", amount: 50 }),
    ];
    const rows = (buildSales(lines, { groupBy: "part" }).rows) as SalesGroupRow[];
    expect(rows).toHaveLength(3); // cA/PN-1 and cB/PN-1 are DIFFERENT parts — not merged
    expect(rows.find((r) => r.key === "cA PN-1")!.revenue).toBe(100);
    expect(rows.find((r) => r.key === "cB PN-1")!.revenue).toBe(50);
    expect(rows.find((r) => r.key === "(no part)")!.revenue).toBe(10);
    expect(rows.reduce((s, r) => s + r.revenue, 0)).toBe(160); // sliced == unsliced
  });

  it("by customer: distinct-document count plus Σrevenue", () => {
    const lines = [
      line({ invoiceId: "A", customerId: "cA", customerCode: "AAA", customerName: "Alpha", amount: 100 }),
      line({ invoiceId: "A", customerId: "cA", customerCode: "AAA", customerName: "Alpha", lineKind: "SURCHARGE", partNumber: "", amount: 10 }),
      line({ invoiceId: "B", customerId: "cB", customerCode: "BBB", customerName: "Beta", amount: 50 }),
    ];
    const rows = (buildSales(lines, { groupBy: "customer" }).rows) as SalesGroupRow[];
    const alpha = rows.find((r) => r.key === "cA")!;
    expect(alpha.revenue).toBe(110); // 100 + 10, one document
    expect(alpha.invoiceCount).toBe(1);
    expect(rows.find((r) => r.key === "cB")!.revenue).toBe(50);
  });

  it("by finalized-month: groups on the yyyy-mm of the finalized date", () => {
    const lines = [
      line({ invoiceId: "A", finalizedDate: "2026-07-15", amount: 100 }),
      line({ invoiceId: "B", finalizedDate: "2026-07-20", amount: 30 }),
      line({ invoiceId: "C", finalizedDate: "2026-08-02", amount: 50 }),
    ];
    const rows = (buildSales(lines, { groupBy: "month" }).rows) as SalesGroupRow[];
    expect(rows.map((r) => r.key)).toEqual(["2026-07", "2026-08"]); // chronological
    expect(rows.find((r) => r.key === "2026-07")!.revenue).toBe(130);
    expect(rows.find((r) => r.key === "2026-07")!.invoiceCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Service wiring — reportSales reads the DB (the frozen snapshot).
// ---------------------------------------------------------------------------------------------

async function makeCustomer(code?: string): Promise<{ id: string; code: string; name: string }> {
  seq += 1;
  return prisma.customer.create({ data: { code: code ?? `SAL${seq}`, name: `Sales Cust ${seq}` } });
}

async function makePart(customerId: string, partNumber: string): Promise<{ id: string; partNumber: string }> {
  seq += 1;
  return prisma.part.create({ data: { customerId, partNumber, name: `Part ${seq}`, eachWeight: "1.0000" } });
}

type LineSpec = { kind: InvoiceLineKindValue; partNumber?: string; partName?: string; amount: number; glAccountId?: string };

async function makeInvoice(opts: {
  customerId: string;
  finalizedAt: Date | null;
  kind?: "INVOICE" | "CREDIT";
  status?: "FINALIZED" | "DRAFT";
  invoiceDate?: Date;
  creditNumber?: number;
  deletedAt?: Date;
  subtotal?: number; surchargeTotal?: number; taxTotal?: number; total?: number;
  lines: LineSpec[];
}): Promise<{ id: string; orderId: string; orderNumber: number }> {
  seq += 1;
  const orderNumber = 950000 + seq;
  const order = await prisma.order.create({
    data: {
      orderNumber, customerId: opts.customerId, status: "INVOICED",
      receivedDate: parseDateOnly("2026-05-01"), requestDate: parseDateOnly("2026-05-01"),
    },
  });
  const status = opts.status ?? "FINALIZED";
  const invoice = await prisma.invoice.create({
    data: {
      kind: opts.kind ?? "INVOICE", status,
      orderId: order.id, customerId: opts.customerId,
      creditNumber: opts.creditNumber ?? null,
      invoiceDate: opts.invoiceDate ?? (opts.finalizedAt ?? parseDateOnly("2026-08-01")),
      finalizedAt: status === "FINALIZED" ? opts.finalizedAt : null,
      deletedAt: opts.deletedAt ?? null,
      subtotal: opts.subtotal ?? 0, surchargeTotal: opts.surchargeTotal ?? 0,
      taxTotal: opts.taxTotal ?? 0, total: opts.total ?? 0,
      lines: {
        create: opts.lines.map((l, i) => ({
          position: i + 1, kind: l.kind,
          partNumber: l.partNumber ?? "", partName: l.partName ?? "",
          glAccountId: l.glAccountId ?? null, glAccountName: l.glAccountId ? "acct" : "",
          description: l.kind, amount: l.amount,
        })),
      },
    },
  });
  return { id: invoice.id, orderId: order.id, orderNumber };
}

describe("reportSales — the frozen snapshot", () => {
  it("reads the invoice-line snapshot, NOT a live join to Part (a rename after finalize changes nothing)", async () => {
    const cust = await makeCustomer();
    const part = await makePart(cust.id, "ORIG-PN");
    await makeInvoice({
      customerId: cust.id, finalizedAt: parseDateOnly("2026-08-01"),
      lines: [{ kind: "OPERATION", partNumber: "ORIG-PN", partName: "Orig Name", amount: 100 }],
      subtotal: 100, total: 100,
    });
    // Rename and re-price the part AFTER the invoice finalized — frozen paper must not move.
    await prisma.part.update({ where: { id: part.id }, data: { partNumber: "NEW-PN", name: "New Name" } });

    const byPart = (await reportSales({ groupBy: "part" })).rows as SalesGroupRow[];
    expect(byPart.find((r) => r.key === `${cust.id} ORIG-PN`)!.revenue).toBe(100); // grouped on the snapshot
    expect(byPart.some((r) => r.key === `${cust.id} NEW-PN`)).toBe(false); // never the live number
    expect((await reportSales({})).total).toBe(100);
    expect(await prisma.auditLog.count()).toBe(0); // a report is a pure read
  });

  it("excludes the TAX line of a taxed invoice from the figure", async () => {
    const cust = await makeCustomer();
    await makeInvoice({
      customerId: cust.id, finalizedAt: parseDateOnly("2026-08-01"),
      lines: [
        { kind: "PART", partNumber: "PN", amount: 0 },
        { kind: "OPERATION", partNumber: "PN", amount: 100 },
        { kind: "TAX", amount: 8 },
      ],
      subtotal: 100, taxTotal: 8, total: 108,
    });
    expect((await reportSales({})).total).toBe(100); // ex-tax
  });

  it("includes a surcharge (blank part) and buckets it under '(no part)' in the by-part cut", async () => {
    const cust = await makeCustomer();
    await makeInvoice({
      customerId: cust.id, finalizedAt: parseDateOnly("2026-08-01"),
      lines: [
        { kind: "PART", partNumber: "PN", amount: 0 },
        { kind: "OPERATION", partNumber: "PN", amount: 100 },
        { kind: "SURCHARGE", amount: 15 },
      ],
      subtotal: 100, surchargeTotal: 15, total: 115,
    });
    expect((await reportSales({})).total).toBe(115); // surcharge counted
    const byPart = (await reportSales({ groupBy: "part" })).rows as SalesGroupRow[];
    expect(byPart.find((r) => r.key === `${cust.id} PN`)!.revenue).toBe(100);
    expect(byPart.find((r) => r.key === "(no part)")!.revenue).toBe(15);
  });

  it("nets a credit down (a credit copies its part lines with money negated)", async () => {
    const cust = await makeCustomer();
    await makeInvoice({
      customerId: cust.id, finalizedAt: parseDateOnly("2026-08-01"),
      lines: [{ kind: "OPERATION", partNumber: "PN", amount: 100 }], subtotal: 100, total: 100,
    });
    await makeInvoice({
      customerId: cust.id, kind: "CREDIT", creditNumber: 700100, finalizedAt: parseDateOnly("2026-08-05"),
      lines: [{ kind: "OPERATION", partNumber: "PN", amount: -30 }], subtotal: -30, total: -30,
    });
    expect((await reportSales({})).total).toBe(70);
  });

  it("recognizes by finalizedAt over a HALF-OPEN [from, nextDay) window — invoiceDate is NOT used", async () => {
    const cust = await makeCustomer();
    // Finalized at the very last second of July; the document is dated in August.
    await makeInvoice({
      customerId: cust.id,
      finalizedAt: new Date("2026-07-31T23:59:59.000Z"),
      invoiceDate: parseDateOnly("2026-08-15"),
      lines: [{ kind: "OPERATION", partNumber: "PN", amount: 100 }], subtotal: 100, total: 100,
    });
    // Half-open through the end of the `to` day: to=2026-07-31 INCLUDES a 23:59:59 finalize…
    expect((await reportSales({ from: "2026-07-01", to: "2026-07-31" })).total).toBe(100);
    // …but to=2026-07-30 excludes it (an inclusive lte-at-midnight would have dropped it either way).
    expect((await reportSales({ from: "2026-07-01", to: "2026-07-30" })).total).toBe(0);
    // invoiceDate (Aug 15) is NOT the recognition basis: an August window must not see it.
    expect((await reportSales({ from: "2026-08-01", to: "2026-08-31" })).total).toBe(0);
    // …and it groups under July, not August.
    const byMonth = (await reportSales({ groupBy: "month" })).rows as SalesGroupRow[];
    expect(byMonth.find((r) => r.key === "2026-07")).toBeDefined();
    expect(byMonth.find((r) => r.key === "2026-08")).toBeUndefined();
  });

  it("counts only FINALIZED, non-discarded documents", async () => {
    const cust = await makeCustomer();
    await makeInvoice({
      customerId: cust.id, status: "DRAFT", finalizedAt: parseDateOnly("2026-08-01"),
      lines: [{ kind: "OPERATION", partNumber: "PN", amount: 100 }], subtotal: 100, total: 100,
    });
    await makeInvoice({
      customerId: cust.id, deletedAt: new Date(), finalizedAt: parseDateOnly("2026-08-01"),
      lines: [{ kind: "OPERATION", partNumber: "PN", amount: 200 }], subtotal: 200, total: 200,
    });
    const result = await reportSales({});
    expect(result.total).toBe(0);
    expect(result.invoiceCount).toBe(0);
  });

  it("400s a malformed finalized-date bound and an unknown groupBy", async () => {
    await expect(reportSales({ from: "not-a-date" })).rejects.toMatchObject({ status: 400 });
    await expect(reportSales({ groupBy: "nonsense" as never })).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------------------------
// The headline: a clean, fully-GL-mapped month reconciles the Sales grand total to the GL
// export's revenue-side postings. This is a property of a clean month, not of the report — the
// report itself needs no GL accounts and simply sums line.amount.
// ---------------------------------------------------------------------------------------------

describe("reportSales — reconciles to the GL export revenue accounts", () => {
  it("Sales grand total (Σ non-tax − credits) == Σ revenue-side postings (excl. A/R and tax)", async () => {
    const mk = (name: string) => prisma.glAccount.create({ data: { name } });
    const ar = await mk("1200-AR");
    const rev = await mk("4010-REV");
    const surRev = await mk("4020-SUR");
    const tax = await mk("2200-TAX");
    await prisma.processStepCode.create({ data: { code: "HT", name: "Heat Treat", glAccountId: rev.id } });
    await prisma.billingConfig.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", arGlAccountId: ar.id, salesTaxGlAccountId: tax.id },
      update: { arGlAccountId: ar.id, salesTaxGlAccountId: tax.id },
    });

    const custX = await makeCustomer("RX");
    const custY = await makeCustomer("RY");

    // Invoice A: OPERATION 100 (rev) + SURCHARGE 15 (surRev), no tax → total 115.
    await makeInvoice({
      customerId: custX.id, finalizedAt: parseDateOnly("2026-07-05"),
      lines: [
        { kind: "PART", partNumber: "PN-A", amount: 0 },
        { kind: "OPERATION", partNumber: "PN-A", amount: 100, glAccountId: rev.id },
        { kind: "SURCHARGE", amount: 15, glAccountId: surRev.id },
      ],
      subtotal: 100, surchargeTotal: 15, total: 115,
    });
    // Invoice B: taxable — OPERATION 200 (rev) + TAX 16 (tax) → total 216.
    await makeInvoice({
      customerId: custY.id, finalizedAt: parseDateOnly("2026-07-12"),
      lines: [
        { kind: "PART", partNumber: "PN-B", amount: 0 },
        { kind: "OPERATION", partNumber: "PN-B", amount: 200, glAccountId: rev.id },
        { kind: "TAX", amount: 16, glAccountId: tax.id },
      ],
      subtotal: 200, taxTotal: 16, total: 216,
    });
    // Credit C: −30 OPERATION (rev) → total −30 (money negated, the createCredit convention).
    await makeInvoice({
      customerId: custX.id, kind: "CREDIT", creditNumber: 700200, finalizedAt: parseDateOnly("2026-07-20"),
      lines: [{ kind: "OPERATION", partNumber: "PN-A", amount: -30, glAccountId: rev.id }],
      subtotal: -30, total: -30,
    });

    const sales = await reportSales({ from: "2026-07-01", to: "2026-07-31" });
    expect(sales.total).toBe(285); // 115 + 200 − 30

    // Close July, then export the full journal — no prior GlPosting, so the delta IS the full journal.
    await asSystem(() => closePeriod(2026, 7));
    const period = await prisma.closePeriod.findFirstOrThrow({ where: { year: 2026, month: 7 }, select: { id: true } });
    const out = await asSystem(() => exportClose(period.id));

    // The batch balances.
    const dr = out.postings.reduce((s, p) => s + p.debit, 0);
    const cr = out.postings.reduce((s, p) => s + p.credit, 0);
    expect(Math.round(dr * 100)).toBe(Math.round(cr * 100));

    // Revenue-side = every posting NOT on the A/R control account and NOT on the sales-tax account.
    // (credit − debit): an invoice's revenue is a credit (+), a credit memo's revenue is a debit (−).
    const revenueSideCents = out.postings
      .filter((p) => p.glAccountId !== ar.id && p.glAccountId !== tax.id)
      .reduce((s, p) => s + Math.round(p.credit * 100) - Math.round(p.debit * 100), 0);
    expect(revenueSideCents).toBe(Math.round(sales.total * 100)); // 28500
  });
});

// ---------------------------------------------------------------------------------------------
// Route gate + export attachment.
// ---------------------------------------------------------------------------------------------

describe("GET /api/reports/sales", () => {
  it("401s without a session, 403s without reports.view, 200s with it", async () => {
    expect((await salesRoute(getReq("http://t/api/reports/sales"), withParams())).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "sales-wrong");
    expect((await salesRoute(getReq("http://t/api/reports/sales", wrong), withParams())).status).toBe(403);

    const viewer = await signInWith(["reports.view"], "sales-viewer");
    const res = await salesRoute(getReq("http://t/api/reports/sales", viewer), withParams());
    expect(res.status).toBe(200);
  });
});

describe("GET /api/reports/sales/export", () => {
  it("requires reports.view and returns an xlsx attachment", async () => {
    expect((await salesExportRoute(getReq("http://t/api/reports/sales/export"), withParams())).status).toBe(401);

    const viewer = await signInWith(["reports.view"], "sales-export-viewer");
    const res = await salesExportRoute(getReq("http://t/api/reports/sales/export", viewer), withParams());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain("Sales.xlsx");
  });
});
