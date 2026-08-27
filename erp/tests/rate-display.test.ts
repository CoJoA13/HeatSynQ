import { expect, it } from "vitest";
import { percentFromFraction, fractionFromPercent } from "@/lib/rate-display";

// #227: the app stores sales tax as a FRACTION (0.07 = 7%) while the finance charge is a percent
// number (1.5 = 1.5%/month), and the UI never said which was which. Every rate field now displays
// and accepts PERCENT; these two convert at the edit/display seam. The shift is an exact decimal-
// string operation — never float multiplication, which renders 0.07 × 100 as 7.000000000000001.

it("percentFromFraction shifts the point right two places, exactly", () => {
  expect(percentFromFraction(0.07)).toBe("7");
  expect(percentFromFraction(0.0625)).toBe("6.25");
  expect(percentFromFraction("0.070000")).toBe("7"); // server-normalized text renders clean
  expect(percentFromFraction(0.000001)).toBe("0.0001"); // Decimal(9,6)'s smallest nonzero
  expect(percentFromFraction(0)).toBe("0");
  expect(percentFromFraction(1)).toBe("100");
});

it("percentFromFraction renders null/blank as blank (an unset rate)", () => {
  expect(percentFromFraction(null)).toBe("");
  expect(percentFromFraction(undefined)).toBe("");
  expect(percentFromFraction("")).toBe("");
});

it("fractionFromPercent shifts the point left two places, exactly", () => {
  expect(fractionFromPercent("7")).toBe("0.07");
  expect(fractionFromPercent("6.25")).toBe("0.0625");
  expect(fractionFromPercent("1.5")).toBe("0.015");
  expect(fractionFromPercent("100")).toBe("1");
  expect(fractionFromPercent("0.0001")).toBe("0.000001");
  expect(fractionFromPercent(" 7 ")).toBe("0.07"); // typed with stray spaces
});

it("handles mid-edit shapes a user actually types", () => {
  expect(fractionFromPercent("7.")).toBe("0.07");
  expect(fractionFromPercent(".5")).toBe("0.005");
  expect(fractionFromPercent("07")).toBe("0.07");
});

it("round-trips exactly through both directions", () => {
  for (const pct of ["7", "6.25", "1.5", "0.0001", "12.3456"]) {
    expect(percentFromFraction(fractionFromPercent(pct))).toBe(pct);
  }
});

it("passes text it cannot parse through unchanged — the server's decimalField stays the validator", () => {
  expect(fractionFromPercent("abc")).toBe("abc");
  expect(fractionFromPercent("-")).toBe("-");
  expect(fractionFromPercent("1.2.3")).toBe("1.2.3");
  expect(fractionFromPercent("")).toBe("");
});

it("does not corrupt a signed value (the server rejects negatives; the leaf must not garble them)", () => {
  expect(fractionFromPercent("-5")).toBe("-0.05");
  expect(percentFromFraction("-0.05")).toBe("-5");
});
