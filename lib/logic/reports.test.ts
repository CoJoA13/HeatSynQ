import { describe, it, expect } from "vitest";
import { REPORT_GROUPS, REPORTS, reportByKey, REPORT_KEYS } from "./reports";

describe("catalog config (prototype canon)", () => {
  it("has the 4 canon groups in order with canon icons", () => {
    expect(REPORT_GROUPS.map((g) => [g.key, g.icon, g.title])).toEqual([
      ["sales", "☷", "Sales"],
      ["ar", "$", "Accounts Receivable"],
      ["production", "◉", "Production & Tracking"],
      ["quotes", "☷", "Quotes"],
    ]);
  });
  it("lists 4 reports per group covering all 16 keys in canon order", () => {
    expect(REPORT_GROUPS.flatMap((g) => g.reports)).toEqual([...REPORT_KEYS]);
  });
  it("every catalog item resolves to a def with the canon title", () => {
    const titles = REPORT_GROUPS.flatMap((g) => g.reports).map((k) => REPORTS[k].title);
    expect(titles).toEqual([
      "Sales by Customer", "Sales by Process", "Sales Summary", "Bookings vs. Shipments",
      "A/R Aging", "Customer Statements", "Cash Receipts", "Past-Due Detail",
      "Equipment Utilization", "On-Time Delivery", "Reject Report", "Work-in-Process",
      "Quotes Dashboard", "Win / Loss", "Quote Aging", "Quoted vs. Won",
    ]);
  });
  it("registry keys are self-consistent", () => {
    for (const key of REPORT_KEYS) expect(REPORTS[key].key).toBe(key);
  });
});

describe("reportByKey", () => {
  it("resolves known keys and rejects unknown ones", () => {
    expect(reportByKey("ar-aging")?.title).toBe("A/R Aging");
    expect(reportByKey("nope")).toBeNull();
  });
});
