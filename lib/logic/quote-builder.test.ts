import { describe, it, expect } from "vitest";
import type { PricingRule, QuotePart } from "@/lib/domain";
import { rateForLine, quoteDates, buildQuoteDraft, STUB_COST_RATIO } from "./quote-builder";

const rules: PricingRule[] = [
  { id: "r1", createdAt: "", updatedAt: "", version: 0, priceKeyId: "pk", process: "Carburize", basis: "per_lb", rateCents: 1030, minChargeCents: 25000 },
  { id: "r2", createdAt: "", updatedAt: "", version: 0, priceKeyId: "pk", process: "Temper", basis: "per_lot", rateCents: 144000, minChargeCents: null },
];

describe("rateForLine", () => {
  it("finds the rule by process + basis", () => {
    expect(rateForLine(rules, "Carburize", "per_lb")).toEqual({ rateCents: 1030, minChargeCents: 25000 });
  });
  it("returns zero rate when no rule matches", () => {
    expect(rateForLine(rules, "Nitride", "per_lb")).toEqual({ rateCents: 0, minChargeCents: null });
  });
});

describe("quoteDates", () => {
  it("sets validUntil 30 days after date", () => {
    const { date, validUntil } = quoteDates("2026-07-01T00:00:00.000Z");
    expect(date).toBe("2026-07-01T00:00:00.000Z");
    expect(validUntil).toBe("2026-07-31T00:00:00.000Z");
  });
});

describe("buildQuoteDraft", () => {
  const parts: QuotePart[] = [{
    id: "qp1", partId: "part-ts4471", material: "4140 steel", quantity: 480,
    lines: [
      { id: "l1", process: "Carburize", basis: "per_lb", qtyOrWeight: 600, rateCents: 1030, minChargeCents: 25000 }, // 618000
      { id: "l2", process: "Temper", basis: "per_lot", qtyOrWeight: 1, rateCents: 144000, minChargeCents: null },     // 144000
    ],
  }];
  it("assembles a draft with computed stub cost and no number field", () => {
    const draft = buildQuoteDraft(
      { customerId: "cust-apex", customerPO: "PO-1", salespersonId: "op-vance", requiredBy: null, discount: null, notes: "", parts },
      "2026-07-01T00:00:00.000Z",
    );
    expect(draft.status).toBe("draft");
    expect(draft.rev).toBe(0);
    expect(draft.wonOrderId).toBeNull();
    expect("number" in draft).toBe(false); // create() assigns Q-#
    expect(draft.estCostCents).toBe(Math.round((618000 + 144000) * STUB_COST_RATIO));
  });
});
