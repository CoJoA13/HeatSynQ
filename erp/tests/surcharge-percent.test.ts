import { describe, it, expect } from "vitest";
import { percentToDecimal, decimalToPercentText } from "@/lib/surcharge-percent";

describe("surcharge percent <-> decimal conversion", () => {
  // The brief's own literal example: "4 on screen stores 0.040000."
  it("converts the brief's literal example both ways", () => {
    expect(percentToDecimal("4")).toBe(0.04);
    expect(decimalToPercentText(0.04)).toBe("4");
  });

  it("round-trips a representative set of percents through decimal and back, save-reload-save style", () => {
    for (const percent of ["4", "2.5", "0.25", "100", "0.0001", "12.3456", "0"]) {
      const decimal = percentToDecimal(percent);
      const displayed = decimalToPercentText(decimal);
      // Re-converting the displayed text must land on the exact same decimal — this is the
      // "save, reload, save again" check the brief calls out: a bug that double-converts (or
      // drifts on floating-point) would show up as displayed !== percent or a second decimal
      // that no longer matches the first.
      expect(displayed).toBe(percent);
      expect(percentToDecimal(displayed)).toBe(decimal);
    }
  });

  it("handles empty and unparseable input as null, not NaN or a thrown error", () => {
    expect(percentToDecimal("")).toBeNull();
    expect(percentToDecimal("   ")).toBeNull();
    expect(percentToDecimal("not-a-number")).toBeNull();
    expect(decimalToPercentText(null)).toBe("");
  });

  it("never emits more than rate's 6 fractional digits, even from a longer percent", () => {
    // 12.34567 / 100 = 0.1234567 (7 fractional digits) — must be fixed to 6, not passed through.
    expect(percentToDecimal("12.34567")).toBe(0.123457);
  });
});
