import { describe, it, expect } from "vitest";
import { normalizePriceText } from "@/lib/price-display";

// #14 item 4 — ONE display convention for 4-decimal prices: the text a fresh reload would render.
// The server serializes its Decimal columns to JS numbers, and React renders a number via its
// shortest round-trip string — so "0.5500" typed into a blur-saved input reads "0.55" after a
// reload. Re-setting the input to that same form on a SUCCESSFUL blur-save means the session
// never shows text a reload would contradict.
describe("normalizePriceText (#14 item 4)", () => {
  it("drops trailing zeros the way a reloaded number renders", () => {
    expect(normalizePriceText("0.5500")).toBe("0.55");
    expect(normalizePriceText("2.50")).toBe("2.5");
    expect(normalizePriceText("1.0000")).toBe("1");
  });

  it("normalizes leading forms the same way", () => {
    expect(normalizePriceText(".5")).toBe("0.5");
    expect(normalizePriceText("007")).toBe("7");
    expect(normalizePriceText(" 2.5 ")).toBe("2.5");
  });

  it("is idempotent on already-normal text", () => {
    expect(normalizePriceText("0.55")).toBe("0.55");
    expect(normalizePriceText("1234.5678")).toBe("1234.5678");
    expect(normalizePriceText("0")).toBe("0");
  });

  // Defensive — a successful save implies a parseable decimal, and the callers skip
  // blank-to-null saves entirely.
  it("returns unparseable or blank input unchanged", () => {
    expect(normalizePriceText("abc")).toBe("abc");
    expect(normalizePriceText("")).toBe("");
    expect(normalizePriceText("   ")).toBe("   ");
  });
});
