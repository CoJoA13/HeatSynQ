import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import { DEMO_NOW } from "@/lib/clock";
import type { ReportData, ReportResult } from "./report-types";
import { arAging, customerStatements, cashReceipts, pastDueDetail } from "./reports-ar";

const s = buildSeed();
const data: ReportData = {
  quotes: s.quotes, orders: s.workOrders, invoices: s.invoices, customers: s.customers, equipment: s.equipment,
};
const kpi = (r: ReportResult, label: string) => r.kpis.find((k) => k.label === label)?.value;

describe("arAging", () => {
  const r = arAging.build(data, DEMO_NOW);
  it("pins the 5 buckets — everything current at DEMO_NOW", () => {
    expect(kpi(r, "Current")).toBe("$6,740");
    expect(kpi(r, "1–30 days")).toBe("$0");
    expect(kpi(r, "31–60 days")).toBe("$0");
    expect(kpi(r, "61–90 days")).toBe("$0");
    expect(kpi(r, "90+ days")).toBe("$0");
  });
  it("lists the single sent invoice with a Current pill", () => {
    expect(r.table.rows).toHaveLength(1);
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "INV-30412" });
    expect(r.table.rows[0][4]).toEqual({ kind: "pill", label: "Current", tone: "neutral" });
  });
  it("moves the invoice into d31_60 at Sep 15 (dashboard.test precedent)", () => {
    const later = arAging.build(data, "2026-09-15T00:00:00.000Z");
    expect(kpi(later, "31–60 days")).toBe("$6,740");
    expect(later.table.rows[0][4]).toEqual({ kind: "pill", label: "31–60 days", tone: "warn" });
  });
});

describe("customerStatements", () => {
  const r = customerStatements.build(data, DEMO_NOW);
  it("pins open balance, unbilled, and customer count", () => {
    expect(kpi(r, "Open balance")).toBe("$6,740");
    expect(kpi(r, "Unbilled")).toBe("$7,090");
    expect(kpi(r, "Customers")).toBe("3");
  });
  it("sorts Delta (balance) above Summit/Midwest (unbilled)", () => {
    expect(r.table.rows).toHaveLength(3);
    expect(r.table.rows[0][0]).toEqual({ kind: "text", value: "Delta Turbine" });
    expect(r.table.rows[0][4]).toEqual({ kind: "text", value: "Net 30" });
  });
});

describe("cashReceipts", () => {
  const r = cashReceipts.build(data, DEMO_NOW);
  it("pins June receipts", () => {
    expect(kpi(r, "Receipts MTD")).toBe("$12,760");
    expect(kpi(r, "Receipts")).toBe("2");
  });
  it("sorts newest paid first", () => {
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "INV-30408" });
    expect(r.table.rows[1][0]).toEqual({ kind: "mono", value: "INV-30401" });
  });
});

describe("pastDueDetail", () => {
  it("is honestly empty at DEMO_NOW", () => {
    const r = pastDueDetail.build(data, DEMO_NOW);
    expect(kpi(r, "Past due")).toBe("$0");
    expect(kpi(r, "Invoices")).toBe("0");
    expect(kpi(r, "Oldest")).toBe("—");
    expect(r.table.rows).toHaveLength(0);
  });
  it("surfaces the sent invoice once past due (Sep 15 → 50 days)", () => {
    const r = pastDueDetail.build(data, "2026-09-15T00:00:00.000Z");
    expect(r.table.rows).toHaveLength(1);
    expect(r.table.rows[0][4]).toEqual({ kind: "mono", value: "50d" });
    expect(kpi(r, "Oldest")).toBe("50d");
    expect(kpi(r, "Past due")).toBe("$6,740");
  });
});
