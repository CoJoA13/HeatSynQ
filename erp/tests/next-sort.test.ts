import { describe, it, expect } from "vitest";
import { nextSort } from "@/lib/next-sort";

// H1 (Codex round 3 review): the part-fields admin add-row draft used to seed its sort from
// `rows.length`, which only equals "one past the highest sort" when every row's sort is
// contiguous from 0. A gap (rows sorted 0, 2 — e.g. after a row in between was deleted) made the
// next draft duplicate a live sort (`rows.length` = 2) instead of landing after it.
describe("nextSort", () => {
  it("is 0 for an empty list", () => {
    expect(nextSort([])).toBe(0);
  });

  it("is one past the highest existing sort when contiguous from 0", () => {
    expect(nextSort([{ sort: 0 }, { sort: 1 }])).toBe(2);
  });

  it("is one past the highest existing sort even with a gap, not rows.length", () => {
    // Two rows (sort 0, 2) — rows.length is 2, which would collide with the existing sort-2 row.
    expect(nextSort([{ sort: 0 }, { sort: 2 }])).toBe(3);
  });

  it("ignores row order — max, not the last element", () => {
    expect(nextSort([{ sort: 5 }, { sort: 1 }, { sort: 3 }])).toBe(6);
  });
});
