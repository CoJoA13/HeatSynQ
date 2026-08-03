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
});
