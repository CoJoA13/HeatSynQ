import { describe, it, expect } from "vitest";
import { REPORT_KEYS, cell, ageDays, ratioPct } from "./report-types";

describe("report keys", () => {
  it("defines exactly the 16 canon report keys", () => {
    expect(REPORT_KEYS).toEqual([
      "sales-by-customer", "sales-by-process", "sales-summary", "bookings-vs-shipments",
      "ar-aging", "customer-statements", "cash-receipts", "past-due-detail",
      "equipment-utilization", "on-time-delivery", "reject-report", "work-in-process",
      "quotes-dashboard", "win-loss", "quote-aging", "quoted-vs-won",
    ]);
  });
});

describe("cell constructors", () => {
  it("builds tagged cells", () => {
    expect(cell.text("Apex")).toEqual({ kind: "text", value: "Apex" });
    expect(cell.mono("WO-48211")).toEqual({ kind: "mono", value: "WO-48211" });
    expect(cell.date("2026-06-27T00:00:00.000Z")).toEqual({ kind: "date", iso: "2026-06-27T00:00:00.000Z" });
    expect(cell.money(674000)).toEqual({ kind: "money", cents: 674000 });
    expect(cell.pct("66.7%")).toEqual({ kind: "pct", value: "66.7%" });
    expect(cell.pill("Late", "danger")).toEqual({ kind: "pill", label: "Late", tone: "danger" });
    expect(cell.progress(42)).toEqual({ kind: "progress", pct: 42 });
  });
});

describe("ageDays (UTC floor-day difference)", () => {
  const asOf = "2026-06-30T12:00:00.000Z";
  it("same UTC day is 0 regardless of time-of-day", () => {
    expect(ageDays("2026-06-30T00:00:00.000Z", asOf)).toBe(0);
  });
  it("counts whole days", () => {
    expect(ageDays("2026-06-24T00:00:00.000Z", asOf)).toBe(6);
    expect(ageDays("2026-06-12T00:00:00.000Z", asOf)).toBe(18);
  });
  it("clamps future dates to 0", () => {
    expect(ageDays("2026-07-04T00:00:00.000Z", asOf)).toBe(0);
  });
});

describe("ratioPct", () => {
  it("renders one-decimal percent", () => {
    expect(ratioPct(2, 3)).toBe("66.7%");
    expect(ratioPct(2659000, 2739000)).toBe("97.1%");
    expect(ratioPct(0, 5)).toBe("0%");
  });
  it("renders an em dash when the denominator is 0", () => {
    expect(ratioPct(0, 0)).toBe("—");
  });
});
