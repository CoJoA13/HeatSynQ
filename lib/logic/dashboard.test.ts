import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import {
  openOrders, lateOrders, onSchedulePct,
  openQuotes, awaitingApprovalCount, openQuoteValueCents, wonQuotesCount,
  certsAwaitingRelease, openArCents, pastDueCents, toBillCount, toBillCents, invoicedMtdCents,
  dashboardKpis, navBadgeCounts,
} from "./dashboard";

const s = buildSeed();
const asOf = "2026-06-30T12:00:00.000Z";
const byLabel = (tiles: { label: string; value: string }[]) =>
  Object.fromEntries(tiles.map((t) => [t.label, t.value]));

describe("dashboard order metrics", () => {
  it("counts open and late orders and on-schedule %", () => {
    expect(openOrders(s.workOrders).length).toBe(7);
    expect(lateOrders(s.workOrders, asOf).length).toBe(2);
    expect(onSchedulePct(s.workOrders, asOf)).toBe(71.4);
  });
});

describe("dashboard quote metrics", () => {
  it("counts open quotes, awaiting approval, value, and wins", () => {
    expect(openQuotes(s.quotes).length).toBe(3);
    expect(awaitingApprovalCount(s.quotes)).toBe(1);
    expect(openQuoteValueCents(s.quotes)).toBe(1_256_000);
    expect(wonQuotesCount(s.quotes)).toBe(2);
  });
});

describe("dashboard finance + cert metrics", () => {
  it("computes AR, to-bill, invoiced MTD and pending certs", () => {
    expect(certsAwaitingRelease(s.certifications)).toBe(2);
    expect(openArCents(s.invoices)).toBe(674_000);
    expect(pastDueCents(s.invoices, asOf)).toBe(0);
    expect(toBillCount(s.invoices)).toBe(2);
    expect(toBillCents(s.invoices)).toBe(709_000);
    expect(invoicedMtdCents(s.invoices, asOf)).toBe(1_950_000);
  });

  it("past-due branch: inv-30412 (invoicedDate 2026-06-27) is ~80 days old at Sep-15 → past due", () => {
    // At 2026-09-15, inv-30412 is ~80 days past its June 27 invoiced date → not "current"
    const laterAsOf = "2026-09-15T00:00:00.000Z";
    expect(pastDueCents(s.invoices, laterAsOf)).toBe(674_000);
    // No invoice has an invoicedDate in September → sameMonth check excludes all
    expect(invoicedMtdCents(s.invoices, laterAsOf)).toBe(0);
  });
});

describe("dashboardKpis by role", () => {
  const data = { orders: s.workOrders, quotes: s.quotes, invoices: s.invoices, certifications: s.certifications };
  it("manager tiles", () => {
    const t = byLabel(dashboardKpis("manager", data, asOf));
    expect(t["Open Orders"]).toBe("7");
    expect(t["Late Orders"]).toBe("2");
    expect(t["On-Time %"]).toBe("71.4");
    expect(t["Certs Awaiting Release"]).toBe("2");
    expect(t["Open A/R"]).toBe("$6,740");
    expect(t["Invoiced MTD"]).toBe("$19,500");
  });
  it("sales tiles", () => {
    const t = byLabel(dashboardKpis("sales", data, asOf));
    expect(t["Open Quotes"]).toBe("3");
    expect(t["Awaiting Approval"]).toBe("1");
    expect(t["Open Quote Value"]).toBe("$12,560");
    expect(t["Won Quotes"]).toBe("2");
  });
  it("office tiles", () => {
    const t = byLabel(dashboardKpis("office", data, asOf));
    expect(t["Open A/R"]).toBe("$6,740");
    expect(t["Past Due"]).toBe("$0");
    expect(t["To-bill"]).toBe("2");
    expect(t["Invoiced MTD"]).toBe("$19,500");
  });
});

describe("navBadgeCounts", () => {
  it("computes live sidebar counts", () => {
    expect(navBadgeCounts(s.quotes, s.workOrders, s.certifications)).toEqual({
      quotes: 3, orders: 7, certifications: 2,
    });
  });
});
