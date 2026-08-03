import { describe, expect, it } from "vitest";
import { splitLoads, type LoadSplit } from "@/lib/load-split";

// Pure module, no DB: the auto-split math (spec §5.4) that turns an order's totals into loads
// under the lead part's qty/weight caps. Every case here is empirically checked to sum exactly —
// see load-split.ts's header comment on why the implementation stays in integer cents rather
// than floating pounds until the final division.

function sumQty(loads: LoadSplit[]): number {
  return loads.reduce((s, l) => s + l.qty, 0);
}
function sumWeight(loads: LoadSplit[]): number {
  return loads.reduce((s, l) => s + l.weight, 0);
}

describe("splitLoads", () => {
  it("no caps set: a single load carries the totals unchanged", () => {
    const loads = splitLoads({ totalQty: 500, totalWeight: 1234.56, loadQty: null, loadWeight: null });
    expect(loads).toEqual([{ qty: 500, weight: 1234.56 }]);
  });

  it("qty cap only: 1,000 @ loadQty 300 → 300/300/300/100", () => {
    const loads = splitLoads({ totalQty: 1000, totalWeight: 1000, loadQty: 300, loadWeight: null });
    expect(loads).toEqual([
      { qty: 300, weight: 300 },
      { qty: 300, weight: 300 },
      { qty: 300, weight: 300 },
      { qty: 100, weight: 100 },
    ]);
    expect(sumQty(loads)).toBe(1000);
    expect(sumWeight(loads)).toBe(1000);
  });

  it("weight cap only: 1,000 pcs @ 2.6 lb each, loadWeight 700 → floor(700/2.6) = 269/load", () => {
    const loads = splitLoads({ totalQty: 1000, totalWeight: 2600, loadQty: null, loadWeight: 700 });
    expect(loads.map((l) => l.qty)).toEqual([269, 269, 269, 193]);
    expect(loads.map((l) => l.weight)).toEqual([699.4, 699.4, 699.4, 501.8]);
    expect(sumQty(loads)).toBe(1000);
    expect(sumWeight(loads)).toBe(2600);
  });

  it("both caps set together: the tighter one wins (269 from weight, not loadQty's 300)", () => {
    const loads = splitLoads({ totalQty: 1000, totalWeight: 2600, loadQty: 300, loadWeight: 700 });
    expect(loads.map((l) => l.qty)).toEqual([269, 269, 269, 193]);
    expect(loads[0].qty).not.toBe(300);
    expect(sumQty(loads)).toBe(1000);
    expect(sumWeight(loads)).toBe(2600);
  });

  it("heavy-piece clamp: a piece heavier than loadWeight still gets its own load (never 0)", () => {
    // 3 pieces @ 900 lb each; loadWeight 700 < 900, so floor(700/900) = 0, clamped to 1/load.
    const loads = splitLoads({ totalQty: 3, totalWeight: 2700, loadQty: null, loadWeight: 700 });
    expect(loads).toEqual([
      { qty: 1, weight: 900 },
      { qty: 1, weight: 900 },
      { qty: 1, weight: 900 },
    ]);
    expect(sumQty(loads)).toBe(3);
    expect(sumWeight(loads)).toBe(2700);
  });

  it("exact multiple: 900 @ loadQty 300 → three equal loads, no trailing zero-qty load", () => {
    const loads = splitLoads({ totalQty: 900, totalWeight: 2700, loadQty: 300, loadWeight: null });
    expect(loads).toEqual([
      { qty: 300, weight: 900 },
      { qty: 300, weight: 900 },
      { qty: 300, weight: 900 },
    ]);
    expect(loads).toHaveLength(3); // not 4 — no zero-qty remainder chunk
    expect(sumQty(loads)).toBe(900);
    expect(sumWeight(loads)).toBe(2700);
  });

  it("multi-line order totals (mockup shape): 4,500 @ loadQty 336 → 14 loads, last takes the remainder", () => {
    const loads = splitLoads({ totalQty: 4500, totalWeight: 9000, loadQty: 336, loadWeight: null });
    expect(loads).toHaveLength(14); // ceil(4500 / 336)
    expect(loads.slice(0, 13).every((l) => l.qty === 336)).toBe(true);
    expect(loads[13].qty).toBe(4500 - 13 * 336);
    expect(sumQty(loads)).toBe(4500);
    expect(sumWeight(loads)).toBe(9000);
  });

  it("weights sum exactly to the total in every case above — no floating-point drift", () => {
    const cases = [
      { totalQty: 500, totalWeight: 1234.56, loadQty: null, loadWeight: null },
      { totalQty: 1000, totalWeight: 1000, loadQty: 300, loadWeight: null },
      { totalQty: 1000, totalWeight: 2600, loadQty: null, loadWeight: 700 },
      { totalQty: 1000, totalWeight: 2600, loadQty: 300, loadWeight: 700 },
      { totalQty: 3, totalWeight: 2700, loadQty: null, loadWeight: 700 },
      { totalQty: 900, totalWeight: 2700, loadQty: 300, loadWeight: null },
      { totalQty: 4500, totalWeight: 9000, loadQty: 336, loadWeight: null },
    ];
    for (const c of cases) {
      const loads = splitLoads(c);
      expect(sumQty(loads)).toBe(c.totalQty);
      expect(sumWeight(loads)).toBe(c.totalWeight);
    }
  });
});
