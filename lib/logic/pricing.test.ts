import { describe, it, expect } from "vitest";
import { lineAmountCents, quoteSubtotalCents, applyDiscountCents, marginPct } from "@/lib/logic/pricing";
import type { QuotePart } from "@/lib/domain";

describe("pricing", () => {
  it("multiplies rate by qty/weight", () => {
    expect(lineAmountCents({ qtyOrWeight: 600, rateCents: 1030, minChargeCents: null })).toBe(618000);
  });
  it("applies the min charge floor", () => {
    expect(lineAmountCents({ qtyOrWeight: 1, rateCents: 10000, minChargeCents: 25000 })).toBe(25000);
  });
  it("sums all line amounts across parts", () => {
    const parts = [{ id:"p", partId:"x", material:"4140", quantity:480, lines: [
      { id:"l1", process:"Carburize", basis:"per_lb", qtyOrWeight:600, rateCents:1030, minChargeCents:null },
      { id:"l2", process:"Temper", basis:"per_lot", qtyOrWeight:1, rateCents:144000, minChargeCents:null },
      { id:"l3", process:"Certification", basis:"flat", qtyOrWeight:1, rateCents:80000, minChargeCents:null },
    ]}] as unknown as QuotePart[];
    expect(quoteSubtotalCents(parts)).toBe(842000);
  });
  it("applies amount and percent discounts", () => {
    expect(applyDiscountCents(842000, { kind:"amount", value:42000 })).toBe(800000);
    expect(applyDiscountCents(800000, { kind:"percent", value:10 })).toBe(720000);
    expect(applyDiscountCents(842000, null)).toBe(842000);
  });
  it("computes whole-percent margin", () => {
    expect(marginPct(842000, 488360)).toBe(42); // (842000-488360)/842000 = 0.42
  });
});
