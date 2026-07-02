import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import { DEMO_NOW } from "@/lib/clock";
import type { ReportData, ReportResult } from "./report-types";
import { quotesDashboard, winLoss, quoteAging, quotedVsWon } from "./reports-quotes";

const s = buildSeed();
const data: ReportData = {
  quotes: s.quotes, orders: s.workOrders, invoices: s.invoices, customers: s.customers, equipment: s.equipment,
};
const EMPTY: ReportData = { quotes: [], orders: [], invoices: [], customers: [], equipment: [] };
const kpi = (r: ReportResult, label: string) => r.kpis.find((k) => k.label === label)?.value;

describe("quotesDashboard", () => {
  const r = quotesDashboard.build(data, DEMO_NOW);
  it("pins the open pipeline", () => {
    expect(kpi(r, "Open quotes")).toBe("3");
    expect(kpi(r, "Open value")).toBe("$12,560");
    expect(kpi(r, "Awaiting approval")).toBe("1");
  });
  it("sorts newest first", () => {
    expect(r.table.rows).toHaveLength(3);
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "Q-2841" });
    expect(r.table.rows[0][5]).toEqual({ kind: "pill", label: "Approve", tone: "warn" });
  });
});

describe("winLoss", () => {
  const r = winLoss.build(data, DEMO_NOW);
  it("pins decided-quote outcomes", () => {
    expect(kpi(r, "Won")).toBe("2");
    expect(kpi(r, "Lost")).toBe("1");
    expect(kpi(r, "Win rate")).toBe("66.7%");
    expect(kpi(r, "Won value")).toBe("$3,740");
  });
  it("lists 3 decided quotes, newest first", () => {
    expect(r.table.rows).toHaveLength(3);
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "Q-2838" });
    expect(r.table.rows[0][4]).toEqual({ kind: "pill", label: "Won", tone: "success" });
  });
  it("dashes the rate with no decided quotes", () => {
    expect(kpi(winLoss.build(EMPTY, DEMO_NOW), "Win rate")).toBe("—");
  });
});

describe("quoteAging", () => {
  const r = quoteAging.build(data, DEMO_NOW);
  it("pins ages 18/6/0 → avg 8d, oldest 18d", () => {
    expect(kpi(r, "Open")).toBe("3");
    expect(kpi(r, "Avg age")).toBe("8d");
    expect(kpi(r, "Oldest")).toBe("18d");
  });
  it("sorts oldest first with mono age cells", () => {
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "Q-2835" });
    expect(r.table.rows[0][4]).toEqual({ kind: "mono", value: "18d" });
  });
  it("dashes ages when no open quotes", () => {
    const r0 = quoteAging.build(EMPTY, DEMO_NOW);
    expect(kpi(r0, "Avg age")).toBe("—");
    expect(kpi(r0, "Oldest")).toBe("—");
  });
});

describe("quotedVsWon", () => {
  const r = quotedVsWon.build(data, DEMO_NOW);
  it("pins the June window (May-dated Q-2828 excluded)", () => {
    expect(kpi(r, "Quoted MTD")).toBe("$25,996");
    expect(kpi(r, "Won MTD")).toBe("$1,700");
    expect(kpi(r, "Conversion")).toBe("6.5%");
  });
  it("sorts customers by quoted desc — Vulcan's lost quote leads honestly", () => {
    expect(r.table.rows).toHaveLength(5);
    expect(r.table.rows[0][0]).toEqual({ kind: "text", value: "Vulcan Forge" });
    expect(r.table.rows[0][1]).toEqual({ kind: "money", cents: 1_173_600 });
    expect(r.table.rows[0][2]).toEqual({ kind: "money", cents: 0 });
  });
});
