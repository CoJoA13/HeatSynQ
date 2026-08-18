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

  // Fix-wave R2 finding 2: independently rounding each non-final load's share to the cent can
  // consume more cents than the total actually holds, and the last load — which just absorbs
  // whatever rounding left over — goes negative to make the books balance. This is the exact
  // counter-example from the finding: 5 pieces, 3 cents total, capped at 1/load. The old
  // per-chunk rounding rounds every one of the first four loads' 0.6-cent share UP to a full
  // cent (4 cents spent on 4 loads), leaving the fifth load to absorb totalCents(3) - used(4) =
  // -1 cent.
  it("counter-example: totalQty=5, totalWeight=0.03, loadWeight cap 0.01 never goes negative", () => {
    const loads = splitLoads({ totalQty: 5, totalWeight: 0.03, loadQty: null, loadWeight: 0.01 });
    expect(loads.map((l) => l.qty)).toEqual([1, 1, 1, 1, 1]);
    expect(loads.every((l) => l.weight >= 0)).toBe(true);
    expect(sumQty(loads)).toBe(5);
    expect(sumWeight(loads)).toBeCloseTo(0.03, 10);
    // Cumulative rounding's own exact contract for this case (0.6 cents/load, banked
    // cumulatively): 1, 0, 1, 0, 1 cents -> 0.01, 0, 0.01, 0, 0.01.
    expect(loads.map((l) => l.weight)).toEqual([0.01, 0, 0.01, 0, 0.01]);
  });

  it("no load's weight is ever negative and no load exceeds its proportional share by more than a cent (property check over many odd ratios)", () => {
    const cases: { totalQty: number; totalWeight: number; loadQty: number | null; loadWeight: number | null }[] = [];
    for (let totalQty = 1; totalQty <= 23; totalQty++) {
      for (let cents = 1; cents <= 47; cents++) {
        cases.push({ totalQty, totalWeight: cents / 100, loadQty: Math.max(1, Math.floor(totalQty / 3)) || 1, loadWeight: null });
      }
    }
    for (const c of cases) {
      const loads = splitLoads(c);
      const perLoadQty = c.loadQty ?? c.totalQty;
      const idealCentsPerLoad = (Math.round(c.totalWeight * 100) * perLoadQty) / c.totalQty;
      for (const l of loads) {
        expect(l.weight).toBeGreaterThanOrEqual(0);
      }
      // Every load's cents are within 1 cent of its ideal proportional share (cumulative
      // rounding's own guarantee) — checked on every load, not just the ones at perLoadQty.
      for (const l of loads) {
        const idealForThisLoad = (Math.round(c.totalWeight * 100) * l.qty) / c.totalQty;
        expect(Math.abs(Math.round(l.weight * 100) - idealForThisLoad)).toBeLessThanOrEqual(1);
      }
      expect(sumQty(loads)).toBe(c.totalQty);
      expect(loads.reduce((s, l) => s + Math.round(l.weight * 100), 0)).toBe(Math.round(c.totalWeight * 100));
      void idealCentsPerLoad;
    }
  });

  // Fix-wave R2 finding 3: nothing capped how many loads a split could produce — a huge qty with
  // a tiny loadQty cap synchronously allocates one object per load before ever returning, and did
  // so unboundedly (the finding's own repro: 10,000,000 pcs at 1/load).
  describe("the 10,000-load cap", () => {
    it("throws instead of allocating 10,000,000 load objects, naming the count and the cap", () => {
      expect(() => splitLoads({ totalQty: 10_000_000, totalWeight: 10_000_000, loadQty: 1, loadWeight: null }))
        .toThrow("This split would produce 10000000 loads (max 10,000) — check the part's load quantity");
    });

    it("boundary: exactly 10,000 loads is allowed; 10,001 is refused", () => {
      const atCap = splitLoads({ totalQty: 10_000, totalWeight: 10_000, loadQty: 1, loadWeight: null });
      expect(atCap).toHaveLength(10_000);

      expect(() => splitLoads({ totalQty: 10_001, totalWeight: 10_001, loadQty: 1, loadWeight: null }))
        .toThrow("This split would produce 10001 loads (max 10,000) — check the part's load quantity");
    });

    it("the weight-cap path is bounded the same way (loadQty derived from loadWeight, not just loadQty itself)", () => {
      // eachWeight 1, loadWeight cap 1 -> perLoadQty 1 -> same 10,001-load overflow, reached
      // through the OTHER cap this time.
      expect(() => splitLoads({ totalQty: 10_001, totalWeight: 10_001, loadQty: null, loadWeight: 1 }))
        .toThrow("This split would produce 10001 loads (max 10,000) — check the part's load quantity");
    });
  });

  // #42: the split's OUTPUT must fit the destination columns — `Load.qty` is a Postgres INTEGER
  // (max 2,147,483,647) and `Load.weight` a DECIMAL(12,2) (max 9,999,999,999.99). Independently
  // valid lines can sum past either (215 lines of 10,000,000 pcs; two near-max weights), and an
  // unchecked load then failed at insert as an unmapped Postgres overflow — a 500. Checked per
  // LOAD, not per total: a total that overflows unsplit is legal once a cap chunks it into loads
  // that each fit.
  describe("the column-range caps (#42)", () => {
    it("refuses a load whose qty exceeds the Int4 ceiling, naming the load and the cap", () => {
      expect(() => splitLoads({ totalQty: 2_150_000_000, totalWeight: 1000, loadQty: null, loadWeight: null }))
        .toThrow("Load 1's quantity 2,150,000,000 exceeds the database maximum 2,147,483,647 — check the line quantities");
    });

    it("refuses a load whose weight exceeds the Decimal(12,2) ceiling, naming the load and the cap", () => {
      expect(() => splitLoads({ totalQty: 2, totalWeight: 19_999_999_999.98, loadQty: null, loadWeight: null }))
        .toThrow("Load 1's weight 19,999,999,999.98 exceeds the database maximum 9,999,999,999.99 — check the line weights");
    });

    it("boundary: a load at exactly both ceilings passes untouched", () => {
      const loads = splitLoads({
        totalQty: 2_147_483_647, totalWeight: 9_999_999_999.99, loadQty: null, loadWeight: null,
      });
      expect(loads).toEqual([{ qty: 2_147_483_647, weight: 9_999_999_999.99 }]);
    });

    it("measures the LOAD, not the total: an overflowing total passes once a cap splits it into fitting loads", () => {
      const loads = splitLoads({ totalQty: 2, totalWeight: 19_999_999_999.98, loadQty: 1, loadWeight: null });
      expect(loads).toEqual([
        { qty: 1, weight: 9_999_999_999.99 },
        { qty: 1, weight: 9_999_999_999.99 },
      ]);
    });

    it("a capped split whose individual loads still overflow is refused all the same", () => {
      // 4 pcs at 7.5e9 lb each, capped 2/load → two loads of 15,000,000,000.00 lb — the cap is
      // honored and the load STILL cannot be stored, so the guard has to look at the output.
      expect(() => splitLoads({ totalQty: 4, totalWeight: 30_000_000_000, loadQty: 2, loadWeight: null }))
        .toThrow("Load 1's weight 15,000,000,000.00 exceeds the database maximum 9,999,999,999.99 — check the line weights");
    });

    // Codex PR #141 round 3: at large-but-legal scale the cumulative proration's float product
    // (`totalCents * cumQty` ≈ 4e25 here) overflowed JavaScript's safe-integer range, and the lost
    // precision shifted a cent between adjacent loads — pushing one load a cent past
    // DECIMAL(12,2) and REFUSING a split every load of which is storable (a false refusal, the
    // over-block direction the boundary tests exist to forbid). The cumulative arithmetic is now
    // exact (BigInt, round-half-up matching Math.round); this construction is the finding's own:
    // 2,329 equal loads, each exactly at the weight ceiling.
    it("prorates 2,329 ceiling-weight loads exactly — no float overflow inventing an overage", () => {
      const loads = splitLoads({
        totalQty: 16_660_175_440, totalWeight: 23_289_999_999_976.71,
        loadQty: 7_153_360, loadWeight: null,
      });
      expect(loads).toHaveLength(2329);
      for (const load of loads) {
        expect(load.qty).toBe(7_153_360);
        expect(load.weight).toBe(9_999_999_999.99);
      }
    });
  });
});
