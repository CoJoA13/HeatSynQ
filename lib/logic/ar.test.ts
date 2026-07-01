import { describe, it, expect } from "vitest";
import type { Invoice } from "@/lib/domain";
import {
  parseNetDays, agingBucket, ageInvoices, customerAging, netDaysByCustomer,
} from "./ar";

const base = { id: "i", createdAt: "", updatedAt: "", version: 0, paidDate: null };
function sent(over: Partial<Invoice>): Invoice {
  return { ...base, number: "INV-1", customerId: "c1", workOrderId: "w1", amountCents: 10000,
    status: "sent", shippedDate: "2026-01-01T00:00:00.000Z", invoicedDate: "2026-01-01T00:00:00.000Z",
    ...over } as Invoice;
}

describe("parseNetDays", () => {
  it("parses Net terms", () => {
    expect(parseNetDays("Net 30")).toBe(30);
    expect(parseNetDays("Net 45")).toBe(45);
    expect(parseNetDays("weird")).toBe(30); // fallback
  });
});

describe("agingBucket (net-terms, due-date based)", () => {
  const inv = sent({ invoicedDate: "2026-01-01T00:00:00.000Z" }); // Net 30 → due 2026-01-31
  it("is current on/before the due date (end-of-day boundary)", () => {
    expect(agingBucket(inv, 30, "2026-01-31T00:00:00.000Z")).toBe("current"); // due today, not past
    expect(agingBucket(inv, 30, "2026-01-15T00:00:00.000Z")).toBe("current");
  });
  it("buckets by days past due", () => {
    expect(agingBucket(inv, 30, "2026-02-05T00:00:00.000Z")).toBe("d1_30");   // 5 days past
    expect(agingBucket(inv, 30, "2026-03-05T00:00:00.000Z")).toBe("d31_60");  // ~33 past
    expect(agingBucket(inv, 30, "2026-04-05T00:00:00.000Z")).toBe("d61_90");  // ~64 past
    expect(agingBucket(inv, 30, "2026-06-05T00:00:00.000Z")).toBe("d90_plus");
  });
  it("guards a NaN ref date as current (never maximally past-due)", () => {
    const bad = sent({ invoicedDate: null, shippedDate: "" });
    expect(agingBucket(bad, 30, "2026-06-05T00:00:00.000Z")).toBe("current");
  });
});

describe("ageInvoices + customerAging", () => {
  const invoices = [
    sent({ id: "a", customerId: "c1", amountCents: 10000, invoicedDate: "2026-01-01T00:00:00.000Z" }),
    sent({ id: "b", customerId: "c1", amountCents: 20000, invoicedDate: "2026-05-01T00:00:00.000Z" }),
    { ...sent({ id: "c", customerId: "c1" }), status: "to_bill" } as Invoice, // excluded
  ];
  const netDays = netDaysByCustomer([{ id: "c1", terms: "Net 30" }]);
  it("sums sent invoices into buckets, ignores non-sent", () => {
    // asOf: 2026-06-05. Invoice a: due 2026-01-31, 125 days past → d90_plus.
    // Invoice b: due 2026-05-31, 5 days past → d1_30.
    const totals = ageInvoices(invoices, netDays, "2026-06-05T00:00:00.000Z");
    expect(totals.d90_plus).toBe(10000);
    expect(totals.d1_30).toBe(20000);
  });
  it("per-customer balance + oldest days past due", () => {
    const a = customerAging(invoices, "c1", 30, "2026-06-05T00:00:00.000Z");
    expect(a.balanceCents).toBe(30000);
    expect(a.pastDueCents).toBe(30000);      // both sent invoices past due: a (125d, 10000) + b (5d, 20000)
    expect(a.oldestDaysPastDue).toBe(125);   // invoice a: due 2026-01-31, asOf 2026-06-05 → 125 days
  });
});
