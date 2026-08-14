import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import {
  buildBacklog, reportBacklog, type OpenLine, type BacklogGroupRow, type BacklogDetailRow,
} from "@/server/reports/backlog";
import { GET as backlogRoute } from "@/app/api/reports/backlog/route";
import { GET as backlogExportRoute } from "@/app/api/reports/backlog/export/route";
import { parseDateOnly, formatDateOnly, addDays, todayDateOnly } from "@/lib/business-days";

// Phase 8A Task 1 (spec §4.2): the Backlog report — open order lines of orders that are not yet
// fully shipped (status ∈ {OPEN, PARTIAL_SHIPPED, REOPENED}, deletedAt: null). REOPENED is
// INCLUDED — an invoiced order reversed back open is genuinely un-shipped work again. Qty/weight
// are the ORDERED amounts (not remaining-to-ship). `buildBacklog` is the pure core; `reportBacklog`
// is the thin Prisma-reading wrapper; a report is a pure read (no claim, no audit).

beforeEach(truncateAll);

let seq = 0;

const withParams = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

async function sheetOf(res: Response): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  return wb.getWorksheet("Backlog")!;
}

// ---------------------------------------------------------------------------------------------
// Pure core — buildBacklog. No DB.
// ---------------------------------------------------------------------------------------------

function line(over: Partial<OpenLine> = {}): OpenLine {
  seq += 1;
  return {
    orderId: `ord-${seq}`, orderNumber: 1000 + seq,
    customerId: "c1", customerCode: "C1", customerName: "Customer One",
    partId: "p1", partNumber: "PN-1", partName: "Widget",
    qty: 10, weight: 25, receivedDate: "2026-08-01", ...over,
  };
}

describe("buildBacklog — detail grain", () => {
  it("emits one detail row per open line, sorted by order number, with days-open = today − receivedDate", () => {
    const today = "2026-08-11";
    const lines = [
      line({ orderId: "o-b", orderNumber: 1002, receivedDate: "2026-08-01" }), // 10 days
      line({ orderId: "o-a", orderNumber: 1001, receivedDate: "2026-08-06" }), // 5 days
    ];
    const result = buildBacklog(lines, { today, groupBy: "none" });
    expect(result.groupBy).toBe("none");
    const rows = result.rows as BacklogDetailRow[];
    expect(rows.map((r) => r.orderNumber)).toEqual([1001, 1002]); // sorted ascending
    expect(rows.find((r) => r.orderNumber === 1002)!.daysOpen).toBe(10);
    expect(rows.find((r) => r.orderNumber === 1001)!.daysOpen).toBe(5);
  });

  it("carries the ORDERED qty/weight straight through to the detail row", () => {
    const rows = (buildBacklog([line({ qty: 42, weight: 137.5 })], { today: "2026-08-11", groupBy: "none" })
      .rows) as BacklogDetailRow[];
    expect(rows[0].qty).toBe(42);
    expect(rows[0].weight).toBe(137.5);
  });
});

describe("buildBacklog — grouping", () => {
  const lines = [
    line({ orderId: "o1", customerId: "cA", customerCode: "AAA", customerName: "Alpha", partId: "pX", partNumber: "PX", partName: "Ex", qty: 10, weight: 5, receivedDate: "2026-07-15" }),
    line({ orderId: "o1", customerId: "cA", customerCode: "AAA", customerName: "Alpha", partId: "pY", partNumber: "PY", partName: "Why", qty: 3, weight: 2, receivedDate: "2026-07-15" }),
    line({ orderId: "o2", customerId: "cA", customerCode: "AAA", customerName: "Alpha", partId: "pX", partNumber: "PX", partName: "Ex", qty: 7, weight: 1, receivedDate: "2026-08-02" }),
    line({ orderId: "o3", customerId: "cB", customerCode: "BBB", customerName: "Beta", partId: "pX", partNumber: "PX", partName: "Ex", qty: 5, weight: 4, receivedDate: "2026-08-20" }),
  ];

  it("by customer: distinct order count, line count, Σqty, Σweight per customer", () => {
    const result = buildBacklog(lines, { today: "2026-08-25", groupBy: "customer" });
    expect(result.groupBy).toBe("customer");
    const rows = result.rows as BacklogGroupRow[];
    const alpha = rows.find((r) => r.key === "cA")!;
    expect(alpha.orderCount).toBe(2); // o1, o2
    expect(alpha.lineCount).toBe(3);
    expect(alpha.qty).toBe(20); // 10 + 3 + 7
    expect(alpha.weight).toBe(8); // 5 + 2 + 1
    const beta = rows.find((r) => r.key === "cB")!;
    expect(beta.orderCount).toBe(1);
    expect(beta.qty).toBe(5);
  });

  it("by part: aggregates across orders/customers on the part", () => {
    const rows = (buildBacklog(lines, { today: "2026-08-25", groupBy: "part" }).rows) as BacklogGroupRow[];
    const px = rows.find((r) => r.key === "pX")!;
    expect(px.lineCount).toBe(3); // o1/pX, o2/pX, o3/pX
    expect(px.orderCount).toBe(3);
    expect(px.qty).toBe(22); // 10 + 7 + 5
  });

  it("by received-month: groups on the yyyy-mm of receivedDate", () => {
    const rows = (buildBacklog(lines, { today: "2026-08-25", groupBy: "month" }).rows) as BacklogGroupRow[];
    expect(rows.map((r) => r.key)).toEqual(["2026-07", "2026-08"]); // sorted
    const jul = rows.find((r) => r.key === "2026-07")!;
    expect(jul.lineCount).toBe(2);
    expect(jul.qty).toBe(13); // 10 + 3
    const aug = rows.find((r) => r.key === "2026-08")!;
    expect(aug.lineCount).toBe(2);
    expect(aug.qty).toBe(12); // 7 + 5
  });

  it("sums fractional weights in integer hundredths — no float drift", () => {
    const rows = (buildBacklog(
      [line({ customerId: "cA", weight: 0.1 }), line({ customerId: "cA", weight: 0.2 })],
      { today: "2026-08-25", groupBy: "customer" },
    ).rows) as BacklogGroupRow[];
    expect(rows[0].weight).toBe(0.3); // not 0.30000000000000004
  });
});

// ---------------------------------------------------------------------------------------------
// Service wiring — reportBacklog reads the DB.
// ---------------------------------------------------------------------------------------------

async function makeCustomer(code?: string): Promise<{ id: string; code: string; name: string }> {
  seq += 1;
  return prisma.customer.create({ data: { code: code ?? `BKC${seq}`, name: `Backlog Cust ${seq}` } });
}

async function makePart(customerId: string, partNumber?: string): Promise<{ id: string; partNumber: string }> {
  seq += 1;
  return prisma.part.create({
    data: { customerId, partNumber: partNumber ?? `BKP${seq}`, name: `Part ${seq}`, eachWeight: "1.0000" },
  });
}

type Status = "OPEN" | "PARTIAL_SHIPPED" | "SHIPPED" | "INVOICED" | "REOPENED";

async function makeOrder(opts: {
  customerId: string; status?: Status; receivedDate?: string; deletedAt?: Date;
  lines: { partId: string; qty: number; weight: number }[];
}): Promise<{ id: string; orderNumber: number }> {
  seq += 1;
  const orderNumber = 700000 + seq;
  const received = parseDateOnly(opts.receivedDate ?? "2026-08-01");
  return prisma.order.create({
    data: {
      orderNumber, customerId: opts.customerId,
      status: opts.status ?? "OPEN",
      receivedDate: received, requestDate: received,
      deletedAt: opts.deletedAt ?? null,
      lines: {
        create: opts.lines.map((l, i) => ({
          position: i + 1, partId: l.partId, qty: l.qty, weight: l.weight.toFixed(2),
        })),
      },
    },
  });
}

describe("reportBacklog — population", () => {
  it("includes OPEN, PARTIAL_SHIPPED and REOPENED; excludes SHIPPED, INVOICED and voided", async () => {
    const cust = await makeCustomer();
    const part = await makePart(cust.id);
    const open = await makeOrder({ customerId: cust.id, status: "OPEN", lines: [{ partId: part.id, qty: 1, weight: 1 }] });
    const partial = await makeOrder({ customerId: cust.id, status: "PARTIAL_SHIPPED", lines: [{ partId: part.id, qty: 1, weight: 1 }] });
    const reopened = await makeOrder({ customerId: cust.id, status: "REOPENED", lines: [{ partId: part.id, qty: 1, weight: 1 }] });
    const shipped = await makeOrder({ customerId: cust.id, status: "SHIPPED", lines: [{ partId: part.id, qty: 1, weight: 1 }] });
    const invoiced = await makeOrder({ customerId: cust.id, status: "INVOICED", lines: [{ partId: part.id, qty: 1, weight: 1 }] });
    const voided = await makeOrder({ customerId: cust.id, status: "OPEN", deletedAt: new Date(), lines: [{ partId: part.id, qty: 1, weight: 1 }] });

    const result = await reportBacklog({});
    expect(result.groupBy).toBe("none");
    const rows = result.rows as BacklogDetailRow[];
    const present = new Set(rows.map((r) => r.orderNumber));
    expect(present.has(open.orderNumber)).toBe(true);
    expect(present.has(partial.orderNumber)).toBe(true);
    expect(present.has(reopened.orderNumber)).toBe(true); // the load-bearing inclusion
    expect(present.has(shipped.orderNumber)).toBe(false);
    expect(present.has(invoiced.orderNumber)).toBe(false);
    expect(present.has(voided.orderNumber)).toBe(false);

    expect(await prisma.auditLog.count()).toBe(0); // a report is a pure read
  });

  it("computes days-open against today's date", async () => {
    const cust = await makeCustomer();
    const part = await makePart(cust.id);
    const received = formatDateOnly(addDays(todayDateOnly(), -12));
    await makeOrder({ customerId: cust.id, receivedDate: received, lines: [{ partId: part.id, qty: 1, weight: 1 }] });

    const rows = (await reportBacklog({})).rows as BacklogDetailRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].daysOpen).toBe(12);
  });
});

describe("reportBacklog — filters", () => {
  it("narrows to a receivedDate range, a customer, and a part", async () => {
    const custA = await makeCustomer("CUSTA");
    const custB = await makeCustomer("CUSTB");
    const partA1 = await makePart(custA.id, "A1");
    const partA2 = await makePart(custA.id, "A2");
    const partB1 = await makePart(custB.id, "B1");

    const inRange = await makeOrder({ customerId: custA.id, receivedDate: "2026-08-10", lines: [{ partId: partA1.id, qty: 1, weight: 1 }] });
    await makeOrder({ customerId: custA.id, receivedDate: "2026-06-01", lines: [{ partId: partA2.id, qty: 1, weight: 1 }] }); // before range
    await makeOrder({ customerId: custA.id, receivedDate: "2026-08-15", lines: [{ partId: partA2.id, qty: 1, weight: 1 }] }); // other part
    await makeOrder({ customerId: custB.id, receivedDate: "2026-08-12", lines: [{ partId: partB1.id, qty: 1, weight: 1 }] }); // other customer

    const rangeRows = (await reportBacklog({ from: "2026-08-01", to: "2026-08-31" }).then((r) => r.rows)) as BacklogDetailRow[];
    expect(rangeRows.every((r) => r.receivedDate >= "2026-08-01" && r.receivedDate <= "2026-08-31")).toBe(true);
    expect(rangeRows.some((r) => r.receivedDate === "2026-06-01")).toBe(false);

    const custRows = (await reportBacklog({ customerId: custA.id }).then((r) => r.rows)) as BacklogDetailRow[];
    expect(custRows.every((r) => r.customerCode === "CUSTA")).toBe(true);

    const partRows = (await reportBacklog({ partId: partA1.id }).then((r) => r.rows)) as BacklogDetailRow[];
    expect(partRows.map((r) => r.orderNumber)).toEqual([inRange.orderNumber]);
  });

  it("400s a malformed received-date bound", async () => {
    await expect(reportBacklog({ from: "not-a-date" })).rejects.toMatchObject({ status: 400 });
  });

  it("400s an unknown groupBy", async () => {
    await expect(reportBacklog({ groupBy: "nonsense" as never })).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------------------------
// Route gate + export mirror.
// ---------------------------------------------------------------------------------------------

describe("GET /api/reports/backlog", () => {
  it("401s without a session, 403s without reports.view, 200s with it", async () => {
    expect((await backlogRoute(getReq("http://t/api/reports/backlog"), withParams())).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "backlog-wrong");
    expect((await backlogRoute(getReq("http://t/api/reports/backlog", wrong), withParams())).status).toBe(403);

    const viewer = await signInWith(["reports.view"], "backlog-viewer");
    const res = await backlogRoute(getReq("http://t/api/reports/backlog", viewer), withParams());
    expect(res.status).toBe(200);
  });
});

describe("GET /api/reports/backlog/export", () => {
  it("requires reports.view and returns an xlsx attachment", async () => {
    expect((await backlogExportRoute(getReq("http://t/api/reports/backlog/export"), withParams())).status).toBe(401);

    const viewer = await signInWith(["reports.view"], "backlog-export-viewer");
    const res = await backlogExportRoute(getReq("http://t/api/reports/backlog/export", viewer), withParams());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain("Backlog.xlsx");
  });

  it("mirrors the on-screen filter — the export population matches the JSON route under the same query", async () => {
    const custA = await makeCustomer("MIRA");
    const custB = await makeCustomer("MIRB");
    const partA = await makePart(custA.id);
    const partB = await makePart(custB.id);
    await makeOrder({ customerId: custA.id, receivedDate: "2026-08-05", lines: [{ partId: partA.id, qty: 1, weight: 1 }] });
    await makeOrder({ customerId: custB.id, receivedDate: "2026-08-06", lines: [{ partId: partB.id, qty: 1, weight: 1 }] });

    const viewer = await signInWith(["reports.view"], "backlog-mirror");
    const query = `customerId=${custA.id}`;
    const url = `http://t/api/reports/backlog?${query}`;
    const exportUrl = `http://t/api/reports/backlog/export?${query}`;

    const json = (await (await backlogRoute(getReq(url, viewer), withParams())).json()) as { rows: BacklogDetailRow[] };
    const jsonOrders = json.rows.map((r) => r.orderNumber).sort();

    const sheet = await sheetOf(await backlogExportRoute(getReq(exportUrl, viewer), withParams()));
    const exportOrders: number[] = [];
    sheet.eachRow((row, n) => { if (n > 1) exportOrders.push(Number(row.getCell(1).value)); });
    exportOrders.sort();

    expect(exportOrders).toEqual(jsonOrders);
    expect(jsonOrders).toHaveLength(1); // only custA's order, both sides agree
  });
});
