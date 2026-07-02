import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import { DEMO_NOW } from "@/lib/clock";
import type { ReportData, ReportResult } from "./report-types";
import { equipmentUtilization, onTimeDelivery, rejectReport, workInProcess } from "./reports-production";

const s = buildSeed();
const data: ReportData = {
  quotes: s.quotes, orders: s.workOrders, invoices: s.invoices, customers: s.customers, equipment: s.equipment,
};
const kpi = (r: ReportResult, label: string) => r.kpis.find((k) => k.label === label)?.value;

describe("equipmentUtilization", () => {
  const r = equipmentUtilization.build(data, DEMO_NOW);
  it("lists the full roster in order", () => {
    expect(r.table.rows).toHaveLength(10);
    expect(r.table.rows[0][0]).toEqual({ kind: "text", value: "Batch IQ #1" });
  });
  it("pins the state snapshot (verify-at-implementation clause)", () => {
    expect(kpi(r, "Out of service")).toBe("2");
    expect(kpi(r, "Running")).toBe("2");
    expect(kpi(r, "Idle")).toBe("5");
    expect(kpi(r, "Utilization")).toBe("25%");
  });
  it("declares the honest snapshot framing", () => {
    expect(equipmentUtilization.framing).toBe("Current equipment state — utilization history isn't tracked yet.");
  });
});

describe("onTimeDelivery", () => {
  const r = onTimeDelivery.build(data, DEMO_NOW);
  it("mirrors the manager tile numbers", () => {
    expect(kpi(r, "On-time %")).toBe("66.7");
    expect(kpi(r, "Open")).toBe("9");
    expect(kpi(r, "Late")).toBe("3");
  });
  it("sorts by due asc with a Late pill on the overdue first row", () => {
    expect(r.table.rows).toHaveLength(9);
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "WO-48120" });
    expect(r.table.rows[0][4]).toEqual({ kind: "pill", label: "Late", tone: "danger" });
  });
});

describe("rejectReport", () => {
  it("is honestly empty over seed (no inspectResult values exist)", () => {
    const r = rejectReport.build(data, DEMO_NOW);
    expect(kpi(r, "Inspect failures")).toBe("0");
    expect(kpi(r, "Steps inspected")).toBe("0");
    expect(r.table.rows).toHaveLength(0);
  });
  it("surfaces a synthetic inspect failure", () => {
    const order = {
      ...s.workOrders[0],
      steps: s.workOrders[0].steps.map((st, i) =>
        i === 0 ? { ...st, inspectResult: "fail" as const, operatorInitials: "DM" } : st),
    };
    const r = rejectReport.build({ ...data, orders: [order] }, DEMO_NOW);
    expect(kpi(r, "Inspect failures")).toBe("1");
    expect(kpi(r, "Steps inspected")).toBe("1");
    expect(r.table.rows[0][4]).toEqual({ kind: "pill", label: "Fail", tone: "danger" });
    expect(r.table.rows[0][3]).toEqual({ kind: "mono", value: "DM" });
  });
});

describe("workInProcess", () => {
  const r = workInProcess.build(data, DEMO_NOW);
  it("pins WIP = in_process + on_hold", () => {
    expect(kpi(r, "WIP orders")).toBe("5");
    expect(kpi(r, "WIP value")).toBe("$17,970");
    expect(kpi(r, "Late in WIP")).toBe("2");
  });
  it("sorts by due asc with a progress cell", () => {
    expect(r.table.rows[0][0]).toEqual({ kind: "mono", value: "WO-48190" });
    expect(r.table.rows[0][4].kind).toBe("progress");
  });
});
