import { describe, it, expect } from "vitest";
import { shipRemainder } from "@/lib/ship-remainder";

// The ship-now prefill's arithmetic (design §5.1 "the ship-now prefill (`ordered − shipped`,
// editable)", task-14-brief.md Step 2 "prefilled to the remainder"). Pure and client-safe so the
// shipment page's grid can use it without importing src/server/** — and so the one place the
// over-ship default was actually wrong (a partially-shipped line) is covered by a test rather
// than only by a browser click.
describe("shipRemainder", () => {
  it("is the full ordered figure when nothing has shipped yet", () => {
    expect(shipRemainder(10, 0)).toBe(10);
    expect(shipRemainder(25.5, 0)).toBe(25.5);
  });

  it("is ordered minus shipped-to-date for a partially shipped line", () => {
    expect(shipRemainder(10, 4)).toBe(6);
    expect(shipRemainder(25, 10)).toBe(15);
  });

  it("is zero when the line is already shipped in full", () => {
    expect(shipRemainder(10, 10)).toBe(0);
  });

  it("floors at zero rather than proposing a negative ship-now on an over-shipped line", () => {
    expect(shipRemainder(10, 14)).toBe(0);
    expect(shipRemainder(25, 25.5)).toBe(0);
  });

  it("rounds to the two decimals the weight column actually stores", () => {
    // 25 - 12.1 is 12.899999999999999 in binary floating point; the input box must not show that.
    expect(shipRemainder(25, 12.1)).toBe(12.9);
    expect(shipRemainder(0.3, 0.1)).toBe(0.2);
  });
});
