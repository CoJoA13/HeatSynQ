import { describe, expect, it } from "vitest";
import { swapAt } from "@/lib/reorder";

// The bounds-check-and-swap every up/down control in the app repeats before sending a reorder
// (part process steps, template steps, step-code field defs). Extracted here for the same reason
// next-sort.ts was: it is the part with edge cases, and the components around it are unreachable
// from vitest's "node" environment.

describe("swapAt", () => {
  it("swaps with the previous entry", () => {
    expect(swapAt(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
  });

  it("swaps with the next entry", () => {
    expect(swapAt(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });

  it("refuses to move the first entry up", () => {
    expect(swapAt(["a", "b"], 0, -1)).toBeNull();
  });

  it("refuses to move the last entry down", () => {
    expect(swapAt(["a", "b"], 1, 1)).toBeNull();
  });

  it("refuses an index outside the array", () => {
    expect(swapAt(["a", "b"], 5, -1)).toBeNull();
    expect(swapAt(["a", "b"], -1, 1)).toBeNull();
  });

  it("refuses to move the only entry either way", () => {
    expect(swapAt(["a"], 0, -1)).toBeNull();
    expect(swapAt(["a"], 0, 1)).toBeNull();
  });

  it("never mutates the array it was given", () => {
    const items = ["a", "b", "c"];
    swapAt(items, 0, 1);
    expect(items).toEqual(["a", "b", "c"]);
  });
});
