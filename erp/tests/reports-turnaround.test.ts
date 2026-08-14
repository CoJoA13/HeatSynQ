import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import {
  buildTurnaround, reportTurnaround,
  type CompletedOrder, type TurnaroundGroupRow, type TurnaroundDetailRow,
} from "@/server/reports/turnaround";
import { GET as turnaroundRoute } from "@/app/api/reports/turnaround/route";
import { GET as turnaroundExportRoute } from "@/app/api/reports/turnaround/export/route";
import { parseDateOnly } from "@/lib/business-days";

// Phase 8A Task 3 (spec §4.2 / §12): the Turnaround report — average order-to-ship days. There is
// NO stored order-completion timestamp; the completion date is DERIVED from shipments, never the
// audit log. The derivation (pinned): for each order line, the earliest live `Shipper.shipDate`
// whose `ShipperLine` is `lineComplete` (mirroring ship-ledger.ts's per-line "complete" rule); the
// order's completion date = MAX of those per-line dates. Only orders currently fully `SHIPPED` are
// included, and a REOPENED-then-re-completed order recomputes from its CURRENT live shipments —
// ignoring the reversed prior cycle. `buildTurnaround` is the pure core; `reportTurnaround` is the
// thin Prisma-reading wrapper; a report is a pure read (no claim, no audit).

beforeEach(truncateAll);

let seq = 0;

const withParams = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

async function sheetOf(res: Response): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  return wb.getWorksheet("Turnaround")!;
}

// ---------------------------------------------------------------------------------------------
// Pure core — buildTurnaround. No DB. The measure is per ORDER: completionDate − receivedDate in
// whole days. Both dates are @db.Date (UTC-midnight) so the difference is an exact whole-day count.
// ---------------------------------------------------------------------------------------------

function ord(over: Partial<CompletedOrder> = {}): CompletedOrder {
  seq += 1;
  return {
    orderId: `o-${seq}`, orderNumber: 5000 + seq,
    customerId: "c1", customerCode: "C1", customerName: "Customer One",
    receivedDate: "2026-05-01", completionDate: "2026-05-11", // 10 days
    parts: [{ partId: "p1", partNumber: "PN-1", partName: "Widget" }],
    ...over,
  };
}

describe("buildTurnaround — detail grain", () => {
  it("emits one row per order, sorted by completion date then order number, with turnaround days", () => {
    const orders = [
      ord({ orderId: "o-b", orderNumber: 1002, completionDate: "2026-05-31" }), // 30 days
      ord({ orderId: "o-a", orderNumber: 1001, completionDate: "2026-05-11" }), // 10 days
    ];
    const result = buildTurnaround(orders, { groupBy: "none" });
    expect(result.groupBy).toBe("none");
    const rows = result.rows as TurnaroundDetailRow[];
    expect(rows.map((r) => r.completionDate)).toEqual(["2026-05-11", "2026-05-31"]); // sorted ascending
    expect(rows.find((r) => r.orderNumber === 1001)!.turnaroundDays).toBe(10);
    expect(rows.find((r) => r.orderNumber === 1002)!.turnaroundDays).toBe(30);
  });

  it("reports the overall average and order count across the population", () => {
    const orders = [
      ord({ completionDate: "2026-05-11" }), // 10
      ord({ completionDate: "2026-05-21" }), // 20
      ord({ completionDate: "2026-05-31" }), // 30
    ];
    const result = buildTurnaround(orders, { groupBy: "none" });
    expect(result.orderCount).toBe(3);
    expect(result.avgDays).toBe(20); // (10 + 20 + 30) / 3
  });
});

describe("buildTurnaround — grouping", () => {
  it("by customer: distinct-order average per customer, plus count / min / max", () => {
    const orders = [
      ord({ orderId: "o1", customerId: "cA", customerCode: "AAA", customerName: "Alpha", completionDate: "2026-05-11" }), // 10
      ord({ orderId: "o2", customerId: "cA", customerCode: "AAA", customerName: "Alpha", completionDate: "2026-05-31" }), // 30
      ord({ orderId: "o3", customerId: "cB", customerCode: "BBB", customerName: "Beta", completionDate: "2026-05-21" }), // 20
    ];
    const result = buildTurnaround(orders, { groupBy: "customer" });
    expect(result.groupBy).toBe("customer");
    const rows = result.rows as TurnaroundGroupRow[];
    const alpha = rows.find((r) => r.key === "cA")!;
    expect(alpha.orderCount).toBe(2);
    expect(alpha.avgDays).toBe(20); // (10 + 30) / 2
    expect(alpha.minDays).toBe(10);
    expect(alpha.maxDays).toBe(30);
    const beta = rows.find((r) => r.key === "cB")!;
    expect(beta.orderCount).toBe(1);
    expect(beta.avgDays).toBe(20);
  });

  it("by part: attributes the order's turnaround to EACH distinct part; distinct orders per part", () => {
    const orders = [
      ord({ orderId: "o1", customerId: "cA", completionDate: "2026-05-11", parts: [ // 10 days
        { partId: "pX", partNumber: "PX", partName: "Ex" },
        { partId: "pY", partNumber: "PY", partName: "Why" },
      ] }),
      ord({ orderId: "o2", customerId: "cA", completionDate: "2026-05-31", parts: [ // 30 days
        { partId: "pX", partNumber: "PX", partName: "Ex" },
      ] }),
    ];
    const rows = (buildTurnaround(orders, { groupBy: "part" }).rows) as TurnaroundGroupRow[];
    const px = rows.find((r) => r.key === "pX")!;
    expect(px.orderCount).toBe(2); // o1 and o2 both contain PX
    expect(px.avgDays).toBe(20); // (10 + 30) / 2
    const py = rows.find((r) => r.key === "pY")!;
    expect(py.orderCount).toBe(1); // only o1
    expect(py.avgDays).toBe(10);
  });

  it("by part: a part appearing on two lines of one order counts that order ONCE", () => {
    const orders = [
      ord({ orderId: "o1", completionDate: "2026-05-11", parts: [ // 10 days
        { partId: "pX", partNumber: "PX", partName: "Ex" },
        { partId: "pX", partNumber: "PX", partName: "Ex" }, // same part on a second line
      ] }),
    ];
    const rows = (buildTurnaround(orders, { groupBy: "part" }).rows) as TurnaroundGroupRow[];
    const px = rows.find((r) => r.key === "pX")!;
    expect(px.orderCount).toBe(1); // NOT 2 — the order is one order
    expect(px.avgDays).toBe(10);
  });

  it("by completion-month: groups on the yyyy-mm of the completion date", () => {
    const orders = [
      ord({ orderId: "o1", receivedDate: "2026-06-25", completionDate: "2026-07-05" }), // Jul, 10 days
      ord({ orderId: "o2", receivedDate: "2026-07-01", completionDate: "2026-07-21" }), // Jul, 20 days
      ord({ orderId: "o3", receivedDate: "2026-07-22", completionDate: "2026-08-01" }), // Aug, 10 days
    ];
    const rows = (buildTurnaround(orders, { groupBy: "month" }).rows) as TurnaroundGroupRow[];
    expect(rows.map((r) => r.key)).toEqual(["2026-07", "2026-08"]); // sorted chronologically
    const jul = rows.find((r) => r.key === "2026-07")!;
    expect(jul.orderCount).toBe(2);
    expect(jul.avgDays).toBe(15); // (10 + 20) / 2
    expect(rows.find((r) => r.key === "2026-08")!.avgDays).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------------
// Service wiring — reportTurnaround reads the DB and DERIVES the completion date from shipments.
// ---------------------------------------------------------------------------------------------

async function makeCustomer(code?: string): Promise<{ id: string; code: string; name: string }> {
  seq += 1;
  return prisma.customer.create({ data: { code: code ?? `TAC${seq}`, name: `Turnaround Cust ${seq}` } });
}

async function makePart(customerId: string, partNumber?: string): Promise<{ id: string; partNumber: string }> {
  seq += 1;
  return prisma.part.create({
    data: { customerId, partNumber: partNumber ?? `TAP${seq}`, name: `Part ${seq}`, eachWeight: "1.0000" },
  });
}

type Status = "OPEN" | "PARTIAL_SHIPPED" | "SHIPPED" | "INVOICED" | "REOPENED";

async function makeOrder(opts: {
  customerId: string; status?: Status; receivedDate?: string; deletedAt?: Date;
  lines: { partId: string; qty: number; weight: number }[];
}): Promise<{ id: string; orderNumber: number; lineIds: string[] }> {
  seq += 1;
  const received = parseDateOnly(opts.receivedDate ?? "2026-05-01");
  const order = await prisma.order.create({
    data: {
      orderNumber: 600000 + seq, customerId: opts.customerId,
      status: opts.status ?? "SHIPPED",
      receivedDate: received, requestDate: received,
      deletedAt: opts.deletedAt ?? null,
      lines: {
        create: opts.lines.map((l, i) => ({ position: i + 1, partId: l.partId, qty: l.qty, weight: l.weight.toFixed(2) })),
      },
    },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  return { id: order.id, orderNumber: order.orderNumber, lineIds: order.lines.map((l) => l.id) };
}

async function makeShipment(opts: {
  customerId: string; shipDate: string; deletedAt?: Date; reversesShipperId?: string; sequence?: number;
  order: { id: string };
  lines: { orderLineId: string | null; qty: number; weight: number; lineComplete: boolean; partNumber: string; partName?: string }[];
}): Promise<{ id: string; shipperNumber: number }> {
  seq += 1;
  const shipperNumber = 700000 + seq;
  const shipper = await prisma.shipper.create({
    data: {
      shipperNumber, customerId: opts.customerId, shipDate: parseDateOnly(opts.shipDate),
      deletedAt: opts.deletedAt ?? null, reversesShipperId: opts.reversesShipperId ?? null,
      orders: {
        create: {
          orderId: opts.order.id, sequence: opts.sequence ?? seq, position: 1,
          lines: {
            create: opts.lines.map((l, i) => ({
              orderLineId: l.orderLineId, position: i + 1, qty: l.qty, weight: l.weight.toFixed(2),
              lineComplete: l.lineComplete,
              partNumber: l.partNumber, partName: l.partName ?? "",
              orderedQty: Math.abs(l.qty), orderedWeight: Math.abs(l.weight).toFixed(2),
            })),
          },
        },
      },
    },
  });
  return { id: shipper.id, shipperNumber };
}

describe("reportTurnaround — the completion-date derivation", () => {
  it("derives completion = MAX of each line's earliest complete shipDate (multi-shipment order)", async () => {
    const cust = await makeCustomer();
    const p1 = await makePart(cust.id, "P1");
    const p2 = await makePart(cust.id, "P2");
    // Received 2026-05-01; L1 completes 2026-06-10, L2 completes 2026-06-20 (a DIFFERENT shipment).
    const order = await makeOrder({
      customerId: cust.id, status: "SHIPPED", receivedDate: "2026-05-01",
      lines: [{ partId: p1.id, qty: 10, weight: 5 }, { partId: p2.id, qty: 4, weight: 2 }],
    });
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-10", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: "P1" }],
    });
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-20", order,
      lines: [{ orderLineId: order.lineIds[1], qty: 4, weight: 2, lineComplete: true, partNumber: "P2" }],
    });

    const rows = (await reportTurnaround({})).rows as TurnaroundDetailRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].completionDate).toBe("2026-06-20"); // MAX, the day the LAST line completed
    expect(rows[0].completionDate).not.toBe("2026-06-10"); // NOT first-ship
    expect(rows[0].turnaroundDays).toBe(50); // 2026-05-01 → 2026-06-20
    expect(await prisma.auditLog.count()).toBe(0); // a report is a pure read
  });

  it("takes the EARLIEST complete shipDate for a line that completed across two shipments", async () => {
    const cust = await makeCustomer();
    const p1 = await makePart(cust.id, "P1");
    const order = await makeOrder({
      customerId: cust.id, status: "SHIPPED", receivedDate: "2026-05-01",
      lines: [{ partId: p1.id, qty: 10, weight: 5 }],
    });
    // The same line marked complete in two shipments — the earliest is when it first became complete.
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-15", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 6, weight: 3, lineComplete: true, partNumber: "P1" }],
    });
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-05", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 4, weight: 2, lineComplete: true, partNumber: "P1" }],
    });

    const rows = (await reportTurnaround({})).rows as TurnaroundDetailRow[];
    expect(rows[0].completionDate).toBe("2026-06-05"); // earliest of the two complete rows
  });

  it("ignores an INCOMPLETE shipper line (lineComplete = false) when deriving the completion date", async () => {
    const cust = await makeCustomer();
    const p1 = await makePart(cust.id, "P1");
    const order = await makeOrder({
      customerId: cust.id, status: "SHIPPED", receivedDate: "2026-05-01",
      lines: [{ partId: p1.id, qty: 10, weight: 5 }],
    });
    // A partial (incomplete) ship first, then the completing ship — completion is the COMPLETE one.
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-01", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 4, weight: 2, lineComplete: false, partNumber: "P1" }],
    });
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-20", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 6, weight: 3, lineComplete: true, partNumber: "P1" }],
    });

    const rows = (await reportTurnaround({})).rows as TurnaroundDetailRow[];
    expect(rows[0].completionDate).toBe("2026-06-20"); // the complete ship, not the earlier partial
  });
});

describe("reportTurnaround — population", () => {
  it("includes only currently-SHIPPED orders; excludes OPEN / PARTIAL_SHIPPED / INVOICED / voided", async () => {
    const cust = await makeCustomer();
    const part = await makePart(cust.id);

    const shipped = await makeOrder({ customerId: cust.id, status: "SHIPPED", lines: [{ partId: part.id, qty: 10, weight: 5 }] });
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-10", order: shipped,
      lines: [{ orderLineId: shipped.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: part.partNumber }],
    });

    const open = await makeOrder({ customerId: cust.id, status: "OPEN", lines: [{ partId: part.id, qty: 10, weight: 5 }] });
    const partial = await makeOrder({ customerId: cust.id, status: "PARTIAL_SHIPPED", lines: [{ partId: part.id, qty: 10, weight: 5 }] });
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-11", order: partial,
      lines: [{ orderLineId: partial.lineIds[0], qty: 4, weight: 2, lineComplete: false, partNumber: part.partNumber }],
    });

    // An INVOICED order WITH a complete shipment (derivable completion) must still be excluded —
    // only orders CURRENTLY SHIPPED count.
    const invoiced = await makeOrder({ customerId: cust.id, status: "INVOICED", lines: [{ partId: part.id, qty: 10, weight: 5 }] });
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-12", order: invoiced,
      lines: [{ orderLineId: invoiced.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: part.partNumber }],
    });

    // A voided (soft-deleted) SHIPPED order is excluded by deletedAt: null.
    const voided = await makeOrder({ customerId: cust.id, status: "SHIPPED", deletedAt: new Date(), lines: [{ partId: part.id, qty: 10, weight: 5 }] });
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-13", order: voided,
      lines: [{ orderLineId: voided.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: part.partNumber }],
    });

    const rows = (await reportTurnaround({})).rows as TurnaroundDetailRow[];
    const present = new Set(rows.map((r) => r.orderNumber));
    expect(present.has(shipped.orderNumber)).toBe(true);
    expect(present.has(open.orderNumber)).toBe(false);
    expect(present.has(partial.orderNumber)).toBe(false);
    expect(present.has(invoiced.orderNumber)).toBe(false);
    expect(present.has(voided.orderNumber)).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("excludes a shipment whose shipper is voided (soft-deleted) from the derivation", async () => {
    const cust = await makeCustomer();
    const part = await makePart(cust.id);
    const order = await makeOrder({ customerId: cust.id, status: "SHIPPED", receivedDate: "2026-05-01", lines: [{ partId: part.id, qty: 10, weight: 5 }] });
    // A voided completing shipment; then a LIVE completing shipment on a later date. Only the live
    // one may drive the completion date (the ship-ledger live filter, reached through the shipper).
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-01", deletedAt: new Date(), order,
      lines: [{ orderLineId: order.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: part.partNumber }],
    });
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-20", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: part.partNumber }],
    });

    const rows = (await reportTurnaround({})).rows as TurnaroundDetailRow[];
    expect(rows[0].completionDate).toBe("2026-06-20"); // the voided 2026-06-01 ship does not count
  });
});

describe("reportTurnaround — REOPENED-then-re-completed", () => {
  it("recomputes from the CURRENT live shipments, ignoring the reversed prior cycle", async () => {
    const cust = await makeCustomer();
    const p1 = await makePart(cust.id, "P1");
    const order = await makeOrder({
      customerId: cust.id, status: "SHIPPED", receivedDate: "2026-05-01",
      lines: [{ partId: p1.id, qty: 10, weight: 5 }],
    });
    // 1) Original outbound, complete, 2026-06-01 (stays LIVE — a reversal never voids the original).
    const orig = await makeShipment({
      customerId: cust.id, shipDate: "2026-06-01", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: "P1" }],
    });
    // 2) Reversing shipment (negated qty, lineComplete: false, reversesShipperId = original), 2026-06-15.
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-15", reversesShipperId: orig.id, order,
      lines: [{ orderLineId: order.lineIds[0], qty: -10, weight: -5, lineComplete: false, partNumber: "P1" }],
    });
    // 3) Re-ship, complete, 2026-07-05 — the completion that STANDS.
    await makeShipment({
      customerId: cust.id, shipDate: "2026-07-05", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: "P1" }],
    });

    const rows = (await reportTurnaround({})).rows as TurnaroundDetailRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].completionDate).toBe("2026-07-05"); // the NEW completion
    expect(rows[0].completionDate).not.toBe("2026-06-01"); // NOT the reversed original
    expect(rows[0].turnaroundDays).toBe(65); // 2026-05-01 → 2026-07-05
  });

  it("a reversal that is itself voided leaves the ORIGINAL completion standing", async () => {
    const cust = await makeCustomer();
    const p1 = await makePart(cust.id, "P1");
    const order = await makeOrder({
      customerId: cust.id, status: "SHIPPED", receivedDate: "2026-05-01",
      lines: [{ partId: p1.id, qty: 10, weight: 5 }],
    });
    const orig = await makeShipment({
      customerId: cust.id, shipDate: "2026-06-01", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: "P1" }],
    });
    // The reversal was itself voided — the original's completion is NOT undone.
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-15", reversesShipperId: orig.id, deletedAt: new Date(), order,
      lines: [{ orderLineId: order.lineIds[0], qty: -10, weight: -5, lineComplete: false, partNumber: "P1" }],
    });

    const rows = (await reportTurnaround({})).rows as TurnaroundDetailRow[];
    expect(rows[0].completionDate).toBe("2026-06-01"); // the original still stands
  });
});

describe("reportTurnaround — filters and grouping over the DB", () => {
  async function seedThree() {
    const custA = await makeCustomer("TGA");
    const custB = await makeCustomer("TGB");
    const partA = await makePart(custA.id, "PA");
    const partB = await makePart(custB.id, "PB");
    // custA order completing 2026-06-11 (received 2026-06-01 → 10 days)
    const a1 = await makeOrder({ customerId: custA.id, status: "SHIPPED", receivedDate: "2026-06-01", lines: [{ partId: partA.id, qty: 10, weight: 5 }] });
    await makeShipment({ customerId: custA.id, shipDate: "2026-06-11", order: a1, lines: [{ orderLineId: a1.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: "PA" }] });
    // custA order completing 2026-07-31 (received 2026-07-01 → 30 days)
    const a2 = await makeOrder({ customerId: custA.id, status: "SHIPPED", receivedDate: "2026-07-01", lines: [{ partId: partA.id, qty: 10, weight: 5 }] });
    await makeShipment({ customerId: custA.id, shipDate: "2026-07-31", order: a2, lines: [{ orderLineId: a2.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: "PA" }] });
    // custB order completing 2026-07-21 (received 2026-07-01 → 20 days)
    const b1 = await makeOrder({ customerId: custB.id, status: "SHIPPED", receivedDate: "2026-07-01", lines: [{ partId: partB.id, qty: 10, weight: 5 }] });
    await makeShipment({ customerId: custB.id, shipDate: "2026-07-21", order: b1, lines: [{ orderLineId: b1.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: "PB" }] });
    return { custA, custB, partA, partB };
  }

  it("averages by customer / part / completion-month over the DB", async () => {
    const { custA, custB, partA } = await seedThree();

    const byCust = (await reportTurnaround({ groupBy: "customer" })).rows as TurnaroundGroupRow[];
    expect(byCust.find((r) => r.key === custA.id)!.orderCount).toBe(2);
    expect(byCust.find((r) => r.key === custA.id)!.avgDays).toBe(20); // (10 + 30) / 2
    expect(byCust.find((r) => r.key === custB.id)!.avgDays).toBe(20);

    const byPart = (await reportTurnaround({ groupBy: "part" })).rows as TurnaroundGroupRow[];
    expect(byPart.find((r) => r.key === partA.id)!.orderCount).toBe(2);
    expect(byPart.find((r) => r.key === partA.id)!.avgDays).toBe(20);

    const byMonth = (await reportTurnaround({ groupBy: "month" })).rows as TurnaroundGroupRow[];
    expect(byMonth.map((r) => r.key)).toEqual(["2026-06", "2026-07"]);
    expect(byMonth.find((r) => r.key === "2026-06")!.avgDays).toBe(10);
    expect(byMonth.find((r) => r.key === "2026-07")!.orderCount).toBe(2); // a2 (30) + b1 (20)
    expect(byMonth.find((r) => r.key === "2026-07")!.avgDays).toBe(25);
  });

  it("ranges on the DERIVED completion date, and filters by customer and part", async () => {
    const { custA, partA } = await seedThree();

    const inJul = (await reportTurnaround({ from: "2026-07-01", to: "2026-07-31" })).rows as TurnaroundDetailRow[];
    expect(inJul.every((r) => r.completionDate >= "2026-07-01" && r.completionDate <= "2026-07-31")).toBe(true);
    expect(inJul.some((r) => r.completionDate === "2026-06-11")).toBe(false); // June excluded

    const custRows = (await reportTurnaround({ customerId: custA.id, groupBy: "customer" })).rows as TurnaroundGroupRow[];
    expect(custRows.map((r) => r.key)).toEqual([custA.id]);

    const partRows = (await reportTurnaround({ partId: partA.id })).rows as TurnaroundDetailRow[];
    expect(partRows).toHaveLength(2); // both custA orders of partA
  });

  it("400s a malformed completion-date bound and an unknown groupBy", async () => {
    await expect(reportTurnaround({ from: "not-a-date" })).rejects.toMatchObject({ status: 400 });
    await expect(reportTurnaround({ groupBy: "nonsense" as never })).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------------------------
// Route gate + export attachment.
// ---------------------------------------------------------------------------------------------

describe("GET /api/reports/turnaround", () => {
  it("401s without a session, 403s without reports.view, 200s with it", async () => {
    expect((await turnaroundRoute(getReq("http://t/api/reports/turnaround"), withParams())).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "turnaround-wrong");
    expect((await turnaroundRoute(getReq("http://t/api/reports/turnaround", wrong), withParams())).status).toBe(403);

    const viewer = await signInWith(["reports.view"], "turnaround-viewer");
    const res = await turnaroundRoute(getReq("http://t/api/reports/turnaround", viewer), withParams());
    expect(res.status).toBe(200);
  });
});

describe("GET /api/reports/turnaround/export", () => {
  it("requires reports.view and returns an xlsx attachment", async () => {
    expect((await turnaroundExportRoute(getReq("http://t/api/reports/turnaround/export"), withParams())).status).toBe(401);

    const viewer = await signInWith(["reports.view"], "turnaround-export-viewer");
    const res = await turnaroundExportRoute(getReq("http://t/api/reports/turnaround/export", viewer), withParams());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain("Turnaround.xlsx");
  });

  it("mirrors the on-screen filter — the export population matches the JSON route under the same query", async () => {
    const cust = await makeCustomer("MIRT");
    const part = await makePart(cust.id);
    const order = await makeOrder({ customerId: cust.id, status: "SHIPPED", receivedDate: "2026-05-01", lines: [{ partId: part.id, qty: 10, weight: 5 }] });
    await makeShipment({
      customerId: cust.id, shipDate: "2026-06-10", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 10, weight: 5, lineComplete: true, partNumber: part.partNumber }],
    });

    const viewer = await signInWith(["reports.view"], "turnaround-mirror");
    const query = `customerId=${cust.id}`;
    const url = `http://t/api/reports/turnaround?${query}`;
    const exportUrl = `http://t/api/reports/turnaround/export?${query}`;

    const json = (await (await turnaroundRoute(getReq(url, viewer), withParams())).json()) as { rows: TurnaroundDetailRow[] };
    const jsonOrders = json.rows.map((r) => r.orderNumber).sort();

    const sheet = await sheetOf(await turnaroundExportRoute(getReq(exportUrl, viewer), withParams()));
    const exportOrders: number[] = [];
    sheet.eachRow((row, n) => { if (n > 1) exportOrders.push(Number(row.getCell(1).value)); });
    exportOrders.sort();

    expect(exportOrders).toEqual(jsonOrders);
    expect(jsonOrders).toHaveLength(1);
  });
});
