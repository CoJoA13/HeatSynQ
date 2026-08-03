import { describe, expect, it } from "vitest";
import { expandSerialRange } from "@/lib/serial-range";

// Pure module, no DB: order-line serial entry (spec §12.6) keys one range instead of pasting
// every serial by hand. The reject cases mirror the brief's matrix verbatim — nested/multiple
// brace groups, non-numeric bounds, a reversed range, and the 10,000-row expansion cap.

describe("expandSerialRange", () => {
  it("passes a plain string through unchanged when there are no braces", () => {
    expect(expandSerialRange("ABC123")).toEqual(["ABC123"]);
  });

  it("trims surrounding whitespace on a plain string", () => {
    expect(expandSerialRange("  ABC123  ")).toEqual(["ABC123"]);
  });

  it("expands a 25-row range, zero-padded to the first bound's width", () => {
    const expected = Array.from({ length: 25 }, (_, i) => `EC${String(i + 1).padStart(3, "0")}`);
    expect(expandSerialRange("EC{001-025}")).toEqual(expected);
    expect(expandSerialRange("EC{001-025}")).toHaveLength(25);
  });

  it("pads the end bound to the width of the FIRST bound (VS rule): {001-25} ≡ {001-025}", () => {
    expect(expandSerialRange("EC{001-25}")).toEqual(expandSerialRange("EC{001-025}"));
    expect(expandSerialRange("EC{001-25}")[24]).toBe("EC025");
  });

  it("allows both a prefix and a suffix around the group", () => {
    expect(expandSerialRange("{01-04}-B")).toEqual(["01-B", "02-B", "03-B", "04-B"]);
  });

  it("rejects a nested brace group", () => {
    expect(() => expandSerialRange("{{001-025}}")).toThrow();
  });

  it("rejects two separate brace groups", () => {
    expect(() => expandSerialRange("{01-02}{03-04}")).toThrow();
  });

  it("rejects non-numeric bounds", () => {
    expect(() => expandSerialRange("{01-}")).toThrow();
    expect(() => expandSerialRange("{abc-def}")).toThrow();
  });

  it("rejects a start greater than its end", () => {
    expect(() => expandSerialRange("{9-1}")).toThrow(/start.*end/i);
  });

  it("rejects an expansion over 10,000 rows and names the cap in the message", () => {
    expect(() => expandSerialRange("{1-99999}")).toThrow(/10,000/);
  });

  it("allows exactly 10,000 rows and rejects 10,001 — the boundary, not just a big blowout", () => {
    expect(expandSerialRange("{1-10000}")).toHaveLength(10_000);
    expect(() => expandSerialRange("{1-10001}")).toThrow(/10,000/);
  });

  // Fix-wave finding 4: bounds past Number.MAX_SAFE_INTEGER lose precision (both parse to
  // ~1e20), so `count = end - start + 1` can pass the 10,000 cap on a completely bogus value, and
  // the expansion loop's `n++` then no-ops forever once `n` is past 2^53 — a hang, not a slow
  // path. Both bounds are checked, and the boundary at MAX_SAFE_INTEGER itself is still allowed
  // (rejected only by the existing 10,000-row cap above, not by the safe-integer guard).
  it("rejects a start bound past Number.MAX_SAFE_INTEGER instead of hanging", () => {
    expect(() => expandSerialRange("{99999999999999999999-100000000000000000025}")).toThrow(/safe integer/i);
  });

  it("rejects an end bound past Number.MAX_SAFE_INTEGER instead of hanging", () => {
    expect(() => expandSerialRange("{1-99999999999999999999}")).toThrow(/safe integer/i);
  });

  it("boundary sanity: a single-row range AT Number.MAX_SAFE_INTEGER is not rejected by the safe-integer guard", () => {
    const n = String(Number.MAX_SAFE_INTEGER);
    expect(expandSerialRange(`{${n}-${n}}`)).toEqual([n]);
  });
});
