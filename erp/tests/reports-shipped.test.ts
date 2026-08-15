import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import {
  buildShipped, reportShipped,
  type ShippedLine, type ShippedGroupRow, type ShippedDetailRow,
} from "@/server/reports/shipped";
import { GET as shippedRoute } from "@/app/api/reports/shipped/route";
import { GET as shippedExportRoute } from "@/app/api/reports/shipped/export/route";
import { parseDateOnly } from "@/lib/business-days";

// Phase 8A Task 2 (spec §4.2): the Shipped report — actual shipped volume by period. A NEW
// shipDate-windowed aggregation over ShipperLine → ShipperOrder → Shipper.shipDate. It deliberately
// does NOT reuse `shippedTotals` (ship-ledger.ts): that function is keyed on orderLineId with no
// date dimension and SKIPS released rows, so it answers the ordered-vs-shipped invariant, not
// "how much did we ship in this window." The two traps this suite pins:
//   • Reversals are live negative-qty ShipperLine rows on a shipper whose shipDate may differ from
//     the original's — summing live lines auto-nets them into the reversal's OWN shipDate window.
//   • Released rows (orderLineId === null) are REAL shipped material and ARE counted via their
//     snapshot qty/weight/part columns (the deliberate divergence from `shippedTotals`' skip).
// `buildShipped` is the pure core; `reportShipped` is the thin Prisma-reading wrapper; a report is
// a pure read (no claim, no audit).

beforeEach(truncateAll);

let seq = 0;

const withParams = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

// ---------------------------------------------------------------------------------------------
// Pure core — buildShipped. No DB.
// ---------------------------------------------------------------------------------------------

function line(over: Partial<ShippedLine> = {}): ShippedLine {
  seq += 1;
  return {
    shipperId: `s-${seq}`, shipperLineId: `sl-${seq}`, shipperNumber: 8000 + seq, shipDate: "2026-08-01",
    customerId: "c1", customerCode: "C1", customerName: "Customer One",
    partNumber: "PN-1", partName: "Widget",
    qty: 10, weight: 25, ...over,
  };
}

describe("buildShipped — detail grain", () => {
  it("emits one detail row per shipper line, sorted by shipDate then shipper number then part", () => {
    const lines = [
      line({ shipperId: "sB", shipperNumber: 2, shipDate: "2026-08-05", partNumber: "PB" }),
      line({ shipperId: "sA", shipperNumber: 1, shipDate: "2026-08-01", partNumber: "PA" }),
    ];
    const result = buildShipped(lines, { groupBy: "none" });
    expect(result.groupBy).toBe("none");
    const rows = result.rows as ShippedDetailRow[];
    expect(rows.map((r) => r.shipDate)).toEqual(["2026-08-01", "2026-08-05"]); // sorted ascending
  });

  it("carries qty/weight (and negative reversal amounts) straight through to the detail row", () => {
    const rows = (buildShipped([line({ qty: -3, weight: -12.5 })], { groupBy: "none" })
      .rows) as ShippedDetailRow[];
    expect(rows[0].qty).toBe(-3);
    expect(rows[0].weight).toBe(-12.5);
  });
});

describe("buildShipped — grouping", () => {
  it("by customer: shipment count is DISTINCT shippers, plus Σqty, Σweight", () => {
    const lines = [
      line({ shipperId: "sh1", customerId: "cA", customerCode: "AAA", customerName: "Alpha", qty: 10, weight: 5 }),
      line({ shipperId: "sh1", customerId: "cA", customerCode: "AAA", customerName: "Alpha", qty: 3, weight: 2 }),
      line({ shipperId: "sh2", customerId: "cA", customerCode: "AAA", customerName: "Alpha", qty: 7, weight: 1 }),
      line({ shipperId: "sh3", customerId: "cB", customerCode: "BBB", customerName: "Beta", qty: 5, weight: 4 }),
    ];
    const result = buildShipped(lines, { groupBy: "customer" });
    expect(result.groupBy).toBe("customer");
    const rows = result.rows as ShippedGroupRow[];
    const alpha = rows.find((r) => r.key === "cA")!;
    expect(alpha.shipmentCount).toBe(2); // sh1, sh2 — NOT 3 lines
    expect(alpha.qty).toBe(20); // 10 + 3 + 7
    expect(alpha.weight).toBe(8); // 5 + 2 + 1
    const beta = rows.find((r) => r.key === "cB")!;
    expect(beta.shipmentCount).toBe(1);
    expect(beta.qty).toBe(5);
  });

  it("by part: keyed on customer + part number (parts are customer-scoped), aggregating across shippers", () => {
    const lines = [
      line({ customerId: "cA", partNumber: "PX", partName: "Ex", qty: 10, weight: 5, shipperId: "s1" }),
      line({ customerId: "cA", partNumber: "PX", partName: "Ex", qty: 7, weight: 1, shipperId: "s2" }),
      line({ customerId: "cA", partNumber: "PY", partName: "Why", qty: 3, weight: 2, shipperId: "s1" }),
      line({ customerId: "cB", partNumber: "PX", partName: "Ex", qty: 5, weight: 4, shipperId: "s3" }),
    ];
    const rows = (buildShipped(lines, { groupBy: "part" }).rows) as ShippedGroupRow[];
    expect(rows).toHaveLength(3); // cA/PX and cB/PX are DIFFERENT parts — not merged
    const caPx = rows.find((r) => r.key === "cA PX")!;
    expect(caPx.qty).toBe(17); // 10 + 7
    expect(caPx.shipmentCount).toBe(2); // s1, s2
    const cbPx = rows.find((r) => r.key === "cB PX")!;
    expect(cbPx.qty).toBe(5);
  });

  it("by ship-month: groups on the yyyy-mm of shipDate", () => {
    const lines = [
      line({ shipperId: "s1", shipDate: "2026-07-15", qty: 10 }),
      line({ shipperId: "s2", shipDate: "2026-07-20", qty: 3 }),
      line({ shipperId: "s3", shipDate: "2026-08-02", qty: 7 }),
    ];
    const rows = (buildShipped(lines, { groupBy: "month" }).rows) as ShippedGroupRow[];
    expect(rows.map((r) => r.key)).toEqual(["2026-07", "2026-08"]); // sorted chronologically
    expect(rows.find((r) => r.key === "2026-07")!.qty).toBe(13);
    expect(rows.find((r) => r.key === "2026-07")!.shipmentCount).toBe(2);
    expect(rows.find((r) => r.key === "2026-08")!.qty).toBe(7);
  });

  it("by day: groups on the full yyyy-mm-dd of shipDate", () => {
    const lines = [
      line({ shipperId: "s1", shipDate: "2026-08-01", qty: 10 }),
      line({ shipperId: "s2", shipDate: "2026-08-01", qty: 4 }),
      line({ shipperId: "s3", shipDate: "2026-08-02", qty: 7 }),
    ];
    const rows = (buildShipped(lines, { groupBy: "day" }).rows) as ShippedGroupRow[];
    expect(rows.map((r) => r.key)).toEqual(["2026-08-01", "2026-08-02"]);
    expect(rows.find((r) => r.key === "2026-08-01")!.qty).toBe(14);
    expect(rows.find((r) => r.key === "2026-08-01")!.shipmentCount).toBe(2);
  });

  it("a reversal nets into its OWN shipDate window, not the original's", () => {
    const lines = [
      line({ shipperId: "orig", shipDate: "2026-06-15", qty: 10, weight: 5 }),
      line({ shipperId: "rev", shipDate: "2026-07-10", qty: -10, weight: -5 }),
    ];
    const rows = (buildShipped(lines, { groupBy: "month" }).rows) as ShippedGroupRow[];
    expect(rows.find((r) => r.key === "2026-06")!.qty).toBe(10); // full outbound in June
    expect(rows.find((r) => r.key === "2026-07")!.qty).toBe(-10); // reversal in its own July window
  });

  it("sums fractional weights in integer hundredths — no float drift", () => {
    const rows = (buildShipped(
      [line({ customerId: "cA", weight: 0.1 }), line({ customerId: "cA", weight: 0.2 })],
      { groupBy: "customer" },
    ).rows) as ShippedGroupRow[];
    expect(rows[0].weight).toBe(0.3); // not 0.30000000000000004
  });
});

// ---------------------------------------------------------------------------------------------
// Service wiring — reportShipped reads the DB.
// ---------------------------------------------------------------------------------------------

async function makeCustomer(code?: string): Promise<{ id: string; code: string; name: string }> {
  seq += 1;
  return prisma.customer.create({ data: { code: code ?? `SHC${seq}`, name: `Shipped Cust ${seq}` } });
}

async function makePart(customerId: string, partNumber?: string): Promise<{ id: string; partNumber: string }> {
  seq += 1;
  return prisma.part.create({
    data: { customerId, partNumber: partNumber ?? `SHP${seq}`, name: `Part ${seq}`, eachWeight: "1.0000" },
  });
}

async function makeOrderWithLines(
  customerId: string, specs: { partId: string; qty: number; weight: number }[],
): Promise<{ id: string; lineIds: string[] }> {
  seq += 1;
  const received = parseDateOnly("2026-05-01");
  const order = await prisma.order.create({
    data: {
      orderNumber: 900000 + seq, customerId, status: "PARTIAL_SHIPPED",
      receivedDate: received, requestDate: received,
      lines: { create: specs.map((s, i) => ({ position: i + 1, partId: s.partId, qty: s.qty, weight: s.weight.toFixed(2) })) },
    },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  return { id: order.id, lineIds: order.lines.map((l) => l.id) };
}

async function makeShipment(opts: {
  customerId: string; shipDate: string; deletedAt?: Date; reversesShipperId?: string; sequence?: number;
  order: { id: string };
  lines: { orderLineId: string | null; qty: number; weight: number; partNumber: string; partName?: string }[];
}): Promise<{ id: string; shipperNumber: number }> {
  seq += 1;
  const shipperNumber = 800000 + seq;
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

describe("reportShipped — the two traps", () => {
  it("nets a reversal into its own shipDate window (June ships +10, July reversal −10)", async () => {
    const cust = await makeCustomer();
    const part = await makePart(cust.id);
    const order = await makeOrderWithLines(cust.id, [{ partId: part.id, qty: 10, weight: 5 }]);
    const orig = await makeShipment({
      customerId: cust.id, shipDate: "2026-06-15", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 10, weight: 5, partNumber: part.partNumber }],
    });
    await makeShipment({
      customerId: cust.id, shipDate: "2026-07-10", reversesShipperId: orig.id, order,
      lines: [{ orderLineId: order.lineIds[0], qty: -10, weight: -5, partNumber: part.partNumber }],
    });

    const rows = (await reportShipped({ groupBy: "month" })).rows as ShippedGroupRow[];
    const jun = rows.find((r) => r.key === "2026-06")!;
    const jul = rows.find((r) => r.key === "2026-07")!;
    expect(jun.qty).toBe(10);
    expect(jun.weight).toBe(5);
    expect(jul.qty).toBe(-10); // nets in July, NOT back into June
    expect(jul.weight).toBe(-5);
    // Net across both windows is zero — the material went out and came back.
    expect(jun.qty + jul.qty).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0); // a report is a pure read
  });

  it("counts a released row (orderLineId === null) via its snapshot qty/weight/part", async () => {
    const cust = await makeCustomer();
    const part = await makePart(cust.id);
    const order = await makeOrderWithLines(cust.id, [{ partId: part.id, qty: 10, weight: 5 }]);
    // The order line was later deleted (removeLine after the shipment): orderLineId is null and the
    // snapshot columns are all that remain. shippedTotals SKIPS this row; the report must NOT.
    await makeShipment({
      customerId: cust.id, shipDate: "2026-08-01", order,
      lines: [{ orderLineId: null, qty: 7, weight: 4, partNumber: "REL-SNAP", partName: "Released Snap" }],
    });

    const rows = (await reportShipped({})).rows as ShippedDetailRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe(7);
    expect(rows[0].weight).toBe(4);
    expect(rows[0].partNumber).toBe("REL-SNAP"); // snapshot part identity, not a live join
  });

  it("groups a released row by part on its snapshot part number", async () => {
    const cust = await makeCustomer();
    const part = await makePart(cust.id, "LIVE-P");
    const order = await makeOrderWithLines(cust.id, [{ partId: part.id, qty: 10, weight: 5 }]);
    await makeShipment({
      customerId: cust.id, shipDate: "2026-08-01", order,
      lines: [
        { orderLineId: order.lineIds[0], qty: 10, weight: 5, partNumber: "LIVE-P" },
        { orderLineId: null, qty: 6, weight: 3, partNumber: "REL-P" },
      ],
    });
    const rows = (await reportShipped({ groupBy: "part" })).rows as ShippedGroupRow[];
    const released = rows.find((r) => r.key === `${cust.id} REL-P`)!;
    expect(released).toBeDefined();
    expect(released.qty).toBe(6);
    expect(released.weight).toBe(3);
  });
});

describe("reportShipped — population and voids", () => {
  it("excludes a voided (soft-deleted) shipment entirely", async () => {
    const cust = await makeCustomer();
    const part = await makePart(cust.id);
    const order = await makeOrderWithLines(cust.id, [{ partId: part.id, qty: 10, weight: 5 }]);
    await makeShipment({
      customerId: cust.id, shipDate: "2026-08-01", deletedAt: new Date(), order,
      lines: [{ orderLineId: order.lineIds[0], qty: 10, weight: 5, partNumber: part.partNumber }],
    });
    const result = await reportShipped({});
    expect(result.rows).toHaveLength(0);
  });

  it("shipment count counts distinct shippers, not lines (one shipper, two lines → 1)", async () => {
    const cust = await makeCustomer();
    const p1 = await makePart(cust.id);
    const p2 = await makePart(cust.id);
    const order = await makeOrderWithLines(cust.id, [
      { partId: p1.id, qty: 10, weight: 5 }, { partId: p2.id, qty: 4, weight: 2 },
    ]);
    await makeShipment({
      customerId: cust.id, shipDate: "2026-08-01", order,
      lines: [
        { orderLineId: order.lineIds[0], qty: 10, weight: 5, partNumber: p1.partNumber },
        { orderLineId: order.lineIds[1], qty: 4, weight: 2, partNumber: p2.partNumber },
      ],
    });
    const rows = (await reportShipped({ groupBy: "customer" })).rows as ShippedGroupRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].shipmentCount).toBe(1); // one shipper
    expect(rows[0].qty).toBe(14); // both lines summed
  });
});

describe("reportShipped — injected transaction client (Codex fix 1: scoreboard reads one snapshot)", () => {
  it("reads through a passed tx client and returns the SAME result as the autocommit read", async () => {
    const cust = await makeCustomer();
    const part = await makePart(cust.id);
    const order = await makeOrderWithLines(cust.id, [{ partId: part.id, qty: 10, weight: 5 }]);
    await makeShipment({
      customerId: cust.id, shipDate: "2026-08-01", order,
      lines: [{ orderLineId: order.lineIds[0], qty: 10, weight: 5, partNumber: part.partNumber }],
    });

    const filter = { from: "2026-08-01", to: "2026-08-31" };
    const autocommit = await reportShipped(filter);
    // The scoreboard drives this exact path — reportShipped joins the caller's RepeatableRead
    // snapshot rather than its own autocommit read, so the three scoreboard figures agree.
    const inTx = await prisma.$transaction((tx) => reportShipped(filter, tx));
    expect(inTx).toEqual(autocommit);
    expect((inTx.rows as ShippedDetailRow[])[0].qty).toBe(10);
  });
});

describe("reportShipped — grouping over the DB", () => {
  async function seedTwoCustomers() {
    const custA = await makeCustomer("SGA");
    const custB = await makeCustomer("SGB");
    const partA = await makePart(custA.id, "PA");
    const partB = await makePart(custB.id, "PB");
    const orderA = await makeOrderWithLines(custA.id, [{ partId: partA.id, qty: 10, weight: 5 }]);
    const orderB = await makeOrderWithLines(custB.id, [{ partId: partB.id, qty: 20, weight: 8 }]);
    await makeShipment({ customerId: custA.id, shipDate: "2026-07-10", order: orderA, lines: [{ orderLineId: orderA.lineIds[0], qty: 10, weight: 5, partNumber: "PA" }] });
    await makeShipment({ customerId: custA.id, shipDate: "2026-08-10", order: orderA, lines: [{ orderLineId: orderA.lineIds[0], qty: 4, weight: 2, partNumber: "PA" }] });
    await makeShipment({ customerId: custB.id, shipDate: "2026-08-15", order: orderB, lines: [{ orderLineId: orderB.lineIds[0], qty: 20, weight: 8, partNumber: "PB" }] });
    return { custA, custB, partA, partB };
  }

  it("by customer / part / month / day each aggregate correctly", async () => {
    const { custA, custB } = await seedTwoCustomers();

    const byCust = (await reportShipped({ groupBy: "customer" })).rows as ShippedGroupRow[];
    expect(byCust.find((r) => r.key === custA.id)!.shipmentCount).toBe(2);
    expect(byCust.find((r) => r.key === custA.id)!.qty).toBe(14);
    expect(byCust.find((r) => r.key === custB.id)!.qty).toBe(20);

    const byPart = (await reportShipped({ groupBy: "part" })).rows as ShippedGroupRow[];
    expect(byPart.find((r) => r.key === `${custA.id} PA`)!.qty).toBe(14);
    expect(byPart.find((r) => r.key === `${custB.id} PB`)!.qty).toBe(20);

    const byMonth = (await reportShipped({ groupBy: "month" })).rows as ShippedGroupRow[];
    expect(byMonth.find((r) => r.key === "2026-07")!.qty).toBe(10);
    expect(byMonth.find((r) => r.key === "2026-08")!.qty).toBe(24); // 4 + 20
    expect(byMonth.find((r) => r.key === "2026-08")!.shipmentCount).toBe(2);

    const byDay = (await reportShipped({ groupBy: "day" })).rows as ShippedGroupRow[];
    expect(byDay.find((r) => r.key === "2026-07-10")!.qty).toBe(10);
    expect(byDay.find((r) => r.key === "2026-08-10")!.qty).toBe(4);
    expect(byDay.find((r) => r.key === "2026-08-15")!.qty).toBe(20);
  });

  it("narrows to a shipDate range, a customer, and a part", async () => {
    const { custA, partA } = await seedTwoCustomers();

    const inAug = (await reportShipped({ from: "2026-08-01", to: "2026-08-31", groupBy: "day" })).rows as ShippedGroupRow[];
    expect(inAug.every((r) => r.key >= "2026-08-01" && r.key <= "2026-08-31")).toBe(true);
    expect(inAug.some((r) => r.key === "2026-07-10")).toBe(false); // July excluded

    const custRows = (await reportShipped({ customerId: custA.id, groupBy: "customer" })).rows as ShippedGroupRow[];
    expect(custRows.map((r) => r.key)).toEqual([custA.id]);

    const partRows = (await reportShipped({ partId: partA.id })).rows as ShippedDetailRow[];
    expect(partRows.every((r) => r.partNumber === "PA")).toBe(true);
    expect(partRows.length).toBe(2); // both custA shipments of partA
  });

  it("400s a malformed shipDate bound and an unknown groupBy", async () => {
    await expect(reportShipped({ from: "not-a-date" })).rejects.toMatchObject({ status: 400 });
    await expect(reportShipped({ groupBy: "nonsense" as never })).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------------------------
// Route gate + export attachment.
// ---------------------------------------------------------------------------------------------

describe("GET /api/reports/shipped", () => {
  it("401s without a session, 403s without reports.view, 200s with it", async () => {
    expect((await shippedRoute(getReq("http://t/api/reports/shipped"), withParams())).status).toBe(401);

    const wrong = await signInWith(["orders.view"], "shipped-wrong");
    expect((await shippedRoute(getReq("http://t/api/reports/shipped", wrong), withParams())).status).toBe(403);

    const viewer = await signInWith(["reports.view"], "shipped-viewer");
    const res = await shippedRoute(getReq("http://t/api/reports/shipped", viewer), withParams());
    expect(res.status).toBe(200);
  });
});

describe("GET /api/reports/shipped/export", () => {
  it("requires reports.view and returns an xlsx attachment", async () => {
    expect((await shippedExportRoute(getReq("http://t/api/reports/shipped/export"), withParams())).status).toBe(401);

    const viewer = await signInWith(["reports.view"], "shipped-export-viewer");
    const res = await shippedExportRoute(getReq("http://t/api/reports/shipped/export", viewer), withParams());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain("Shipped.xlsx");
  });
});
