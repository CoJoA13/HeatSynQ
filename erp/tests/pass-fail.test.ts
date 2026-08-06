import { describe, it, expect } from "vitest";
import { computePassed } from "@/lib/pass-fail";

// Spec §6.3: `passed` is computed whenever a `value` is present — true when it falls within
// whichever of min/max are set, false otherwise; null when there is no value at all. Bounds are
// inclusive (a reading landing exactly on min or max passes).
describe("computePassed", () => {
  it("returns null when there is no value", () => {
    expect(computePassed(null, 28, 32)).toBeNull();
    expect(computePassed(null, null, null)).toBeNull();
  });

  describe("min only", () => {
    it("fails below min", () => expect(computePassed(27.9, 28, null)).toBe(false));
    it("passes at min", () => expect(computePassed(28, 28, null)).toBe(true));
    it("passes above min", () => expect(computePassed(50, 28, null)).toBe(true));
  });

  describe("max only", () => {
    it("passes below max", () => expect(computePassed(10, null, 32)).toBe(true));
    it("passes at max", () => expect(computePassed(32, null, 32)).toBe(true));
    it("fails above max", () => expect(computePassed(32.1, null, 32)).toBe(false));
  });

  describe("both bounds", () => {
    it("fails below min", () => expect(computePassed(27.9, 28, 32)).toBe(false));
    it("passes at min", () => expect(computePassed(28, 28, 32)).toBe(true));
    it("passes inside the range", () => expect(computePassed(30, 28, 32)).toBe(true));
    it("passes at max", () => expect(computePassed(32, 28, 32)).toBe(true));
    it("fails above max", () => expect(computePassed(32.1, 28, 32)).toBe(false));
  });

  it("passes with a value and neither bound set — nothing to fail against", () => {
    expect(computePassed(30, null, null)).toBe(true);
  });
});
