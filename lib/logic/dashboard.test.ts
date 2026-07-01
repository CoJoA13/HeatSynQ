import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import {
  openOrders, lateOrders, onSchedulePct, isLate,
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
    expect(lateOrders(s.workOrders, asOf).length).toBe(3);
    expect(onSchedulePct(s.workOrders, asOf)).toBe(57.1);
  });

  it("isLate end-of-day boundary: order due same day as asOf is NOT late", () => {
    // Order due 2026-06-30 00:00:00 UTC; asOf = 2026-06-30 12:00:00 UTC.
    // end-of-day of due = 2026-06-30 23:59:59.999 > asOf → not late.
    const orderDueToday = s.workOrders.find((o) => o.id === "wo-48205")!;
    // wo-48205 has due "2026-07-01" — use a synthetic order for the exact boundary
    const syntheticOrder = { ...orderDueToday, due: "2026-06-30T00:00:00.000Z", status: "in_process" as const };
    expect(isLate(syntheticOrder, asOf)).toBe(false);
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
    // inv-30412 (cust-delta, Net 30, invoicedDate 2026-06-27) → due 2026-07-27; not past due at 2026-06-30
    expect(pastDueCents(s.invoices, s.customers, asOf)).toBe(0);
    expect(toBillCount(s.invoices)).toBe(2);
    expect(toBillCents(s.invoices)).toBe(709_000);
    expect(invoicedMtdCents(s.invoices, asOf)).toBe(1_950_000);
  });

  it("past-due branch: inv-30412 (due 2026-07-27) is 50 days past-due at Sep-15 → d31_60 → past due", () => {
    // At 2026-09-15, inv-30412 (Net 30 cust-delta, invoicedDate 2026-06-27 → due 2026-07-27) is ~50 days past due
    const laterAsOf = "2026-09-15T00:00:00.000Z";
    expect(pastDueCents(s.invoices, s.customers, laterAsOf)).toBe(674_000);
    // No invoice has an invoicedDate in September → sameMonth check excludes all
    expect(invoicedMtdCents(s.invoices, laterAsOf)).toBe(0);
  });
});

describe("dashboardKpis by role", () => {
  const data = { orders: s.workOrders, quotes: s.quotes, invoices: s.invoices, certifications: s.certifications, customers: s.customers };
  it("manager tiles", () => {
    const t = byLabel(dashboardKpis("manager", data, asOf));
    expect(t["Open Orders"]).toBe("7");
    expect(t["Late Orders"]).toBe("3");
    expect(t["On-Time %"]).toBe("57.1");
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
