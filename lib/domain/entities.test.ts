import { describe, it, expect } from "vitest";
import { quoteSchema, customerSchema } from "@/lib/domain";

const base = { id: "x", createdAt: "2026-06-30T00:00:00.000Z", updatedAt: "2026-06-30T00:00:00.000Z", version: 0 };

describe("entity schemas", () => {
  it("parses a valid customer", () => {
    const c = customerSchema.parse({
      ...base, customerNumber: "1042", name: "Apex Aerospace", initials: "AA",
      city: "Wichita, KS", billingAddress: "4120 Industrial Pkwy", phone: "(316) 555-0142",
      terms: "Net 30", status: "active", priceKeyId: "pk1", taxExempt: true,
      defaultCertSpecId: "s1", defaultCertCopies: 2, ytdSalesCents: 21400000,
    });
    expect(c.status).toBe("active");
  });
  it("rejects an invalid quote status", () => {
    expect(() => quoteSchema.parse({ ...base, number: "Q-1", rev: 0, customerId: "c1",
      customerPO: "", status: "bogus", salespersonId: "o1", date: base.createdAt,
      validUntil: base.createdAt, requiredBy: null, discount: null, estCostCents: 0,
      notes: "", parts: [], wonOrderId: null })).toThrow();
  });
});
