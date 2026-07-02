import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import { DEMO_NOW } from "@/lib/clock";
import type { ReportData, ReportResult } from "./report-types";
import { salesByCustomer, salesByProcess, salesSummary, bookingsVsShipments } from "./reports-sales";

const s = buildSeed();
const data: ReportData = {
  quotes: s.quotes, orders: s.workOrders, invoices: s.invoices, customers: s.customers, equipment: s.equipment,
};
const EMPTY: ReportData = { quotes: [], orders: [], invoices: [], customers: [], equipment: [] };
const kpi = (r: ReportResult, label: string) => r.kpis.find((k) => k.label === label)?.value;

describe("salesByCustomer", () => {
  const r = salesByCustomer.build(data, DEMO_NOW);
  it("pins seed totals", () => {
    expect(kpi(r, "Invoiced")).toBe("$19,500");
    expect(kpi(r, "Open order value")).toBe("$27,390");
    expect(kpi(r, "Customers")).toBe("7");
  });
  it("has 7 rows, Apex first (highest invoiced), dormant Ironclad excluded", () => {
    expect(r.table.rows).toHaveLength(7);
    expect(r.table.rows[0][0]).toEqual({ kind: "text", value: "Apex Aerospace" });
    expect(r.table.rows[0][1]).toEqual({ kind: "money", cents: 1_120_000 });
  });
  it("is empty-honest", () => {
    expect(salesByCustomer.build(EMPTY, DEMO_NOW).table.rows).toHaveLength(0);
  });
});

describe("salesByProcess", () => {
  const r = salesByProcess.build(data, DEMO_NOW);
  it("pins the seed process rollup", () => {
    expect(kpi(r, "Booked")).toBe("$27,390");
    expect(kpi(r, "Processes")).toBe("8");
    expect(r.table.rows[0][0]).toEqual({ kind: "text", value: "Carburize" });
    expect(r.table.rows[0][1]).toEqual({ kind: "money", cents: 1_118_000 });
    expect(r.table.rows[0][2]).toEqual({ kind: "mono", value: "3" });
  });
});

describe("salesSummary", () => {
  const r = salesSummary.build(data, DEMO_NOW);
  it("pins document-status rollup KPIs", () => {
    expect(kpi(r, "Quoted (open)")).toBe("$12,560");
    expect(kpi(r, "Won")).toBe("$3,740");
    expect(kpi(r, "Booked (open)")).toBe("$27,390");
    expect(kpi(r, "Invoiced")).toBe("$19,500");
    expect(kpi(r, "Collected")).toBe("$12,760");
  });
  it("renders the 8 fixed rows", () => {
    expect(r.table.rows).toHaveLength(8);
    expect(r.table.rows[2][1]).toEqual({ kind: "text", value: "Lost" });
    expect(r.table.rows[2][3]).toEqual({ kind: "money", cents: 1_173_600 });
    expect(r.table.rows[4][2]).toEqual({ kind: "mono", value: "0" }); // shipped WOs
  });
});

describe("bookingsVsShipments", () => {
  const r = bookingsVsShipments.build(data, DEMO_NOW);
  it("pins June MTD totals and ratio", () => {
    expect(kpi(r, "Booked MTD")).toBe("$27,390");
    expect(kpi(r, "Shipped MTD")).toBe("$26,590");
    expect(kpi(r, "Book-to-ship")).toBe("97.1%");
  });
  it("ratio dashes out with no bookings", () => {
    expect(kpi(bookingsVsShipments.build(EMPTY, DEMO_NOW), "Book-to-ship")).toBe("—");
  });
  it("excludes out-of-month records", () => {
    const july = "2026-07-15T00:00:00.000Z";
    expect(kpi(bookingsVsShipments.build(data, july), "Booked MTD")).toBe("$0");
  });
});
