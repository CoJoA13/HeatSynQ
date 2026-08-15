import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import {
  buildScoreboard, reportScoreboard, type ScoreboardFigures,
} from "@/server/reports/scoreboard";
import { reportShipped, type ShippedResult } from "@/server/reports/shipped";
import { thisWeekWindow, thisMonthWindow } from "@/lib/scoreboard-presets";
import { GET as scoreboardRoute } from "@/app/api/reports/scoreboard/route";
import { GET as scoreboardExportRoute } from "@/app/api/reports/scoreboard/export/route";
import { parseDateOnly } from "@/lib/business-days";

// Phase 8A Task 7 (spec §4.3): the Comparison scoreboard — the weekly parallel-run eyeball page.
// THREE HeatSynQ figures for one {from,to} window, to compare against Visual Shop's own reports:
//   • Orders entered — COUNT of orders by `Order.receivedDate`, voided excluded (`deletedAt: null`).
//   • Shipped — pounds & pieces, by REUSING `reportShipped` for the same window (the scoreboard's
//     shipped number MUST equal the Shipped report's — no re-derivation).
//   • Invoiced $ — Σ `Invoice.total` for FINALIZED docs by **`invoiceDate`** (owner ruling — the
//     VS-eyeball basis, NOT `finalizedAt` the way the Sales report recognizes; gross tax-inclusive),
//     credits netted (a CREDIT `total` is negative; its own line + a net).
// `buildScoreboard` is the pure core (shipped summation + invoiced netting, unit-testable);
// `reportScoreboard` is the thin Prisma-reading wrapper. A report is a pure read (no claim, no audit).

beforeEach(truncateAll);

let seq = 0;

const withParams = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

// ---------------------------------------------------------------------------------------------
// Pure core — buildScoreboard. No DB.
// ---------------------------------------------------------------------------------------------

/** A minimal ShippedResult (groupBy none) carrying just the qty/weight the scoreboard sums. */
function shippedResult(rows: { qty: number; weight: number }[]): ShippedResult {
  return {
    groupBy: "none",
    rows: rows.map((r, i) => ({
      shipperId: `s-${i}`, shipperLineId: `sl-${i}`, shipperNumber: 1000 + i, shipDate: "2026-08-01",
      customerCode: "C", customerName: "Cust", partNumber: "P", partName: "Part",
      qty: r.qty, weight: r.weight,
    })),
  };
}

describe("buildScoreboard — pure figures", () => {
  it("sums shipped qty and weight across the rows (weight in integer hundredths — no float drift)", () => {
    const figures = buildScoreboard({
      window: { from: "2026-08-01", to: "2026-08-31" },
      ordersEntered: 4,
      shipped: shippedResult([{ qty: 10, weight: 0.1 }, { qty: 3, weight: 0.2 }]),
      invoices: [],
    });
    expect(figures.ordersEntered).toBe(4);
    expect(figures.shipped.qty).toBe(13);
    expect(figures.shipped.weight).toBe(0.3); // not 0.30000000000000004
    expect(figures.window).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("splits invoiced into invoices, credits (negative) and a net", () => {
    const figures = buildScoreboard({
      window: { from: null, to: null },
      ordersEntered: 0,
      shipped: shippedResult([]),
      invoices: [
        { kind: "INVOICE", total: 100 },
        { kind: "INVOICE", total: 50.25 },
        { kind: "CREDIT", total: -30.25 }, // CREDIT total is stored NEGATIVE
      ],
    });
    expect(figures.invoiced.invoices).toBe(150.25);
    expect(figures.invoiced.credits).toBe(-30.25);
    expect(figures.invoiced.net).toBe(120); // 150.25 − 30.25, netted in integer cents
  });

  it("echoes an empty window and zeroes cleanly", () => {
    const figures = buildScoreboard({
      window: { from: null, to: null }, ordersEntered: 0, shipped: shippedResult([]), invoices: [],
    });
    expect(figures).toEqual<ScoreboardFigures>({
      window: { from: null, to: null },
      ordersEntered: 0,
      shipped: { qty: 0, weight: 0 },
      invoiced: { invoices: 0, credits: 0, net: 0 },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Presets — pure, client-safe window math (both the screen and this test import them).
// ---------------------------------------------------------------------------------------------

describe("scoreboard presets", () => {
  it("this-week is the Monday–Sunday ISO week containing the day", () => {
    // 2026-08-14 is a Friday → Mon 2026-08-10 .. Sun 2026-08-16.
    expect(thisWeekWindow(new Date("2026-08-14T12:00:00Z")))
      .toEqual({ from: "2026-08-10", to: "2026-08-16" });
    // A Sunday resolves to its OWN week (Sun is the last day, not the first of the next).
    expect(thisWeekWindow(new Date("2026-08-16T00:00:00Z")))
      .toEqual({ from: "2026-08-10", to: "2026-08-16" });
    // A Monday is the first day of its week.
    expect(thisWeekWindow(new Date("2026-08-10T23:59:00Z")))
      .toEqual({ from: "2026-08-10", to: "2026-08-16" });
  });

  it("this-month is the first through the last calendar day of the month", () => {
    expect(thisMonthWindow(new Date("2026-08-14T12:00:00Z")))
      .toEqual({ from: "2026-08-01", to: "2026-08-31" });
    // February in a non-leap year ends on the 28th.
    expect(thisMonthWindow(new Date("2026-02-10T12:00:00Z")))
      .toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
});

// ---------------------------------------------------------------------------------------------
// Service wiring — reportScoreboard reads the DB.
// ---------------------------------------------------------------------------------------------

async function makeCustomer(code?: string): Promise<{ id: string; code: string; name: string }> {
  seq += 1;
  return prisma.customer.create({ data: { code: code ?? `SCB${seq}`, name: `Scoreboard Cust ${seq}` } });
}

async function makeOrder(opts: {
  customerId: string; receivedDate: string; deletedAt?: Date;
}): Promise<{ id: string }> {
  seq += 1;
  const received = parseDateOnly(opts.receivedDate);
  const order = await prisma.order.create({
    data: {
      orderNumber: 960000 + seq, customerId: opts.customerId, status: "OPEN",
      receivedDate: received, requestDate: received, deletedAt: opts.deletedAt ?? null,
    },
  });
  return { id: order.id };
}

async function makeInvoice(opts: {
  customerId: string;
  invoiceDate: string;
  finalizedAt: Date | null;
  kind?: "INVOICE" | "CREDIT";
  status?: "FINALIZED" | "DRAFT";
  total: number;
  creditNumber?: number;
  deletedAt?: Date;
}): Promise<void> {
  seq += 1;
  const order = await prisma.order.create({
    data: {
      orderNumber: 970000 + seq, customerId: opts.customerId, status: "INVOICED",
      receivedDate: parseDateOnly("2026-01-01"), requestDate: parseDateOnly("2026-01-01"),
    },
  });
  const status = opts.status ?? "FINALIZED";
  await prisma.invoice.create({
    data: {
      kind: opts.kind ?? "INVOICE", status,
      orderId: order.id, customerId: opts.customerId,
      creditNumber: opts.creditNumber ?? null,
      invoiceDate: parseDateOnly(opts.invoiceDate),
      finalizedAt: status === "FINALIZED" ? opts.finalizedAt : null,
      deletedAt: opts.deletedAt ?? null,
      total: opts.total,
    },
  });
}

async function makePart(customerId: string, partNumber?: string): Promise<{ id: string; partNumber: string }> {
  seq += 1;
  return prisma.part.create({
    data: { customerId, partNumber: partNumber ?? `SCP${seq}`, name: `Part ${seq}`, eachWeight: "1.0000" },
  });
}

async function makeShipment(opts: {
  customerId: string; shipDate: string; deletedAt?: Date;
  partId: string; partNumber: string; qty: number; weight: number;
}): Promise<void> {
  seq += 1;
  const received = parseDateOnly("2026-01-01");
  const order = await prisma.order.create({
    data: {
      orderNumber: 980000 + seq, customerId: opts.customerId, status: "PARTIAL_SHIPPED",
      receivedDate: received, requestDate: received,
      lines: { create: [{ position: 1, partId: opts.partId, qty: opts.qty, weight: opts.weight.toFixed(2) }] },
    },
    include: { lines: true },
  });
  await prisma.shipper.create({
    data: {
      shipperNumber: 990000 + seq, customerId: opts.customerId, shipDate: parseDateOnly(opts.shipDate),
      deletedAt: opts.deletedAt ?? null,
      orders: {
        create: {
          orderId: order.id, sequence: seq, position: 1,
          lines: {
            create: [{
              orderLineId: order.lines[0].id, position: 1, qty: opts.qty, weight: opts.weight.toFixed(2),
              partNumber: opts.partNumber, partName: "",
              orderedQty: opts.qty, orderedWeight: opts.weight.toFixed(2),
            }],
          },
        },
      },
    },
  });
}

describe("reportScoreboard — orders entered (by receivedDate, voided excluded)", () => {
  it("counts orders whose receivedDate is in the window, and NOT voided ones", async () => {
    const cust = await makeCustomer();
    await makeOrder({ customerId: cust.id, receivedDate: "2026-08-05" });
    await makeOrder({ customerId: cust.id, receivedDate: "2026-08-20" });
    await makeOrder({ customerId: cust.id, receivedDate: "2026-07-31" }); // out of window
    // A voided order in the window must NOT count (RED-verify: dropping `deletedAt: null` counts it).
    await makeOrder({ customerId: cust.id, receivedDate: "2026-08-10", deletedAt: new Date() });

    const figures = await reportScoreboard({ from: "2026-08-01", to: "2026-08-31" });
    expect(figures.ordersEntered).toBe(2); // the two live August orders, not July, not the voided one
    expect(await prisma.auditLog.count()).toBe(0); // a report is a pure read
  });
});

describe("reportScoreboard — invoiced $ by invoiceDate (the load-bearing basis)", () => {
  it("buckets by invoiceDate, NOT finalizedAt (a doc finalized in a different month counts by its invoiceDate)", async () => {
    const cust = await makeCustomer();
    // Dated August 15 but FINALIZED back in July — the naive `finalizedAt` copy (Sales report) would
    // count this in July and miss it in August. The scoreboard recognizes it by its invoiceDate.
    await makeInvoice({
      customerId: cust.id, invoiceDate: "2026-08-15",
      finalizedAt: parseDateOnly("2026-07-20"), total: 1000,
    });

    // August window sees it by invoiceDate…
    const aug = await reportScoreboard({ from: "2026-08-01", to: "2026-08-31" });
    expect(aug.invoiced.invoices).toBe(1000);
    expect(aug.invoiced.net).toBe(1000);
    // …and the July window (where it was finalized) does NOT.
    const jul = await reportScoreboard({ from: "2026-07-01", to: "2026-07-31" });
    expect(jul.invoiced.invoices).toBe(0);
    expect(jul.invoiced.net).toBe(0);
  });

  it("nets credits (negative total) against invoices, on their own line", async () => {
    const cust = await makeCustomer();
    await makeInvoice({ customerId: cust.id, invoiceDate: "2026-08-05", finalizedAt: parseDateOnly("2026-08-05"), total: 1000 });
    await makeInvoice({ customerId: cust.id, invoiceDate: "2026-08-06", finalizedAt: parseDateOnly("2026-08-06"), total: 500 });
    await makeInvoice({
      customerId: cust.id, kind: "CREDIT", creditNumber: 780100,
      invoiceDate: "2026-08-10", finalizedAt: parseDateOnly("2026-08-10"), total: -200,
    });
    const figures = await reportScoreboard({ from: "2026-08-01", to: "2026-08-31" });
    expect(figures.invoiced.invoices).toBe(1500);
    expect(figures.invoiced.credits).toBe(-200);
    expect(figures.invoiced.net).toBe(1300);
  });

  it("uses gross tax-inclusive Invoice.total (not an ex-tax line sum)", async () => {
    const cust = await makeCustomer();
    // total is the tax-inclusive document total — 108 = 100 + 8 tax. The scoreboard shows 108.
    await makeInvoice({ customerId: cust.id, invoiceDate: "2026-08-05", finalizedAt: parseDateOnly("2026-08-05"), total: 108 });
    const figures = await reportScoreboard({ from: "2026-08-01", to: "2026-08-31" });
    expect(figures.invoiced.invoices).toBe(108);
  });

  it("counts only FINALIZED, non-discarded documents", async () => {
    const cust = await makeCustomer();
    await makeInvoice({ customerId: cust.id, status: "DRAFT", invoiceDate: "2026-08-05", finalizedAt: null, total: 1000 });
    await makeInvoice({ customerId: cust.id, deletedAt: new Date(), invoiceDate: "2026-08-05", finalizedAt: parseDateOnly("2026-08-05"), total: 2000 });
    const figures = await reportScoreboard({ from: "2026-08-01", to: "2026-08-31" });
    expect(figures.invoiced.invoices).toBe(0);
    expect(figures.invoiced.net).toBe(0);
  });
});

describe("reportScoreboard — shipped equals the Shipped report for the window (reuse, no re-derive)", () => {
  it("matches reportShipped's summed qty/weight and excludes a voided shipment", async () => {
    const cust = await makeCustomer();
    const part = await makePart(cust.id, "SHP-P");
    await makeShipment({ customerId: cust.id, shipDate: "2026-08-05", partId: part.id, partNumber: "SHP-P", qty: 10, weight: 5.5 });
    await makeShipment({ customerId: cust.id, shipDate: "2026-08-20", partId: part.id, partNumber: "SHP-P", qty: 7, weight: 2.25 });
    await makeShipment({ customerId: cust.id, shipDate: "2026-07-15", partId: part.id, partNumber: "SHP-P", qty: 99, weight: 99 }); // out of window
    await makeShipment({ customerId: cust.id, shipDate: "2026-08-10", deletedAt: new Date(), partId: part.id, partNumber: "SHP-P", qty: 42, weight: 42 }); // voided

    const window = { from: "2026-08-01", to: "2026-08-31" };
    const figures = await reportScoreboard(window);
    expect(figures.shipped.qty).toBe(17); // 10 + 7, not the July 99 nor the voided 42
    expect(figures.shipped.weight).toBe(7.75); // 5.5 + 2.25

    // The scoreboard's shipped number MUST equal what the Shipped report shows for the same window.
    const shipped = await reportShipped(window);
    const qty = shipped.rows.reduce((s, r) => s + r.qty, 0);
    const weight = Math.round(shipped.rows.reduce((s, r) => s + r.weight * 100, 0)) / 100;
    expect(figures.shipped.qty).toBe(qty);
    expect(figures.shipped.weight).toBe(weight);
  });
});

describe("reportScoreboard — malformed dates", () => {
  it("400s a malformed window bound", async () => {
    await expect(reportScoreboard({ from: "not-a-date" })).rejects.toMatchObject({ status: 400 });
    await expect(reportScoreboard({ to: "2026-13-40" })).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------------------------
// Route gate + export attachment (mirrors the on-screen figures/window).
// ---------------------------------------------------------------------------------------------

describe("GET /api/reports/scoreboard", () => {
  it("401s without a session, 403s without reports.view, 200s with it", async () => {
    expect((await scoreboardRoute(getReq("http://t/api/reports/scoreboard"), withParams())).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "scoreboard-wrong");
    expect((await scoreboardRoute(getReq("http://t/api/reports/scoreboard", wrong), withParams())).status).toBe(403);

    const viewer = await signInWith(["reports.view"], "scoreboard-viewer");
    const res = await scoreboardRoute(getReq("http://t/api/reports/scoreboard", viewer), withParams());
    expect(res.status).toBe(200);
  });
});

describe("GET /api/reports/scoreboard/export", () => {
  it("401s without a session, 403s without reports.view, and returns an xlsx attachment with it", async () => {
    expect((await scoreboardExportRoute(getReq("http://t/api/reports/scoreboard/export"), withParams())).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "scoreboard-export-wrong");
    expect((await scoreboardExportRoute(getReq("http://t/api/reports/scoreboard/export", wrong), withParams())).status).toBe(403);

    const viewer = await signInWith(["reports.view"], "scoreboard-export-viewer");
    const res = await scoreboardExportRoute(getReq("http://t/api/reports/scoreboard/export", viewer), withParams());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain("Scoreboard.xlsx");
  });

  it("mirrors the on-screen figures for the SAME query string (shared parse)", async () => {
    const cust = await makeCustomer();
    await makeOrder({ customerId: cust.id, receivedDate: "2026-08-05" });
    await makeInvoice({ customerId: cust.id, invoiceDate: "2026-08-05", finalizedAt: parseDateOnly("2026-08-05"), total: 1000 });
    await makeInvoice({
      customerId: cust.id, kind: "CREDIT", creditNumber: 780200,
      invoiceDate: "2026-08-10", finalizedAt: parseDateOnly("2026-08-10"), total: -150,
    });

    const query = "?from=2026-08-01&to=2026-08-31";
    const viewer = await signInWith(["reports.view"], "scoreboard-mirror");
    const figures = await reportScoreboard({ from: "2026-08-01", to: "2026-08-31" });

    const res = await scoreboardExportRoute(getReq(`http://t/api/reports/scoreboard/export${query}`, viewer), withParams());
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const sheet = wb.worksheets[0];
    // Flatten every cell value to a lookup by row label → numeric value.
    const values: Record<string, number> = {};
    sheet.eachRow((row) => {
      const metric = row.getCell(1).value;
      const value = row.getCell(row.cellCount).value;
      if (typeof metric === "string" && typeof value === "number") values[metric] = value;
    });
    // The window is stamped into the file (caption), and the figures match the on-screen numbers.
    const caption = String(sheet.getCell("A1").value ?? "");
    expect(caption).toContain("2026-08-01");
    expect(caption).toContain("2026-08-31");
    expect(Object.values(values)).toContain(figures.ordersEntered);
    expect(Object.values(values)).toContain(figures.invoiced.invoices);
    expect(Object.values(values)).toContain(figures.invoiced.credits);
    expect(Object.values(values)).toContain(figures.invoiced.net);
  });
});
