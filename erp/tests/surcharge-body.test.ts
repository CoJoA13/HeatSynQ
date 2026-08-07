import { describe, it, expect } from "vitest";
import { buildSurchargeBody, type SurchargeRow } from "@/lib/surcharge-body";

// Fix 5 (review, fix wave 1): buildBody was the single thing Task 7 was dispatched to get right
// — the whole-row guarantee plus the kind -> rate/amount nulling — and it sat unexported inside a
// client component, held up by TypeScript alone. Extracted to src/lib/surcharge-body.ts; these
// tests exercise it directly.

const baseRow: SurchargeRow = {
  id: "s1", name: "Energy", kind: "PERCENT",
  rate: 0.04, amount: null, minimumAmount: 10,
  glAccountId: "gl1", glAccountName: "4200", needsGlAccount: false,
  scope: "ALL", position: 1, active: true,
  stepCodeIds: [],
};

describe("buildSurchargeBody", () => {
  it("returns every key on every payload, whichever single field the patch touches", () => {
    const body = buildSurchargeBody(baseRow, { name: "Renamed" });
    expect(Object.keys(body).sort()).toEqual(
      ["active", "amount", "glAccountId", "kind", "minimumAmount", "name", "position", "rate", "scope"].sort(),
    );
    // Every field not in the patch falls back to the row's own value.
    expect(body).toEqual({
      name: "Renamed", kind: "PERCENT", rate: 0.04, amount: null, minimumAmount: 10,
      glAccountId: "gl1", scope: "ALL", position: 1, active: true,
    });
  });

  it("an empty patch reproduces the row exactly, opposite-field nulling included", () => {
    const body = buildSurchargeBody(baseRow, {});
    expect(body).toEqual({
      name: "Energy", kind: "PERCENT", rate: 0.04, amount: null, minimumAmount: 10,
      glAccountId: "gl1", scope: "ALL", position: 1, active: true,
    });
  });

  it("a deliberate null in the patch overrides the row's stored value, not falls back to it", () => {
    const body = buildSurchargeBody(baseRow, { glAccountId: null });
    expect(body.glAccountId).toBeNull();
  });

  it("nulls amount for a PERCENT row even if a stale non-null amount is sitting on the row", () => {
    // An "impossible" row state (PERCENT with a leftover amount) shouldn't be reachable in
    // practice, but the guarantee is that buildSurchargeBody enforces the invariant regardless of
    // what it's handed — it must not simply pass a stale opposite-field value through.
    const row: SurchargeRow = { ...baseRow, kind: "PERCENT", rate: 0.04, amount: 5 };
    const body = buildSurchargeBody(row, {});
    expect(body.kind).toBe("PERCENT");
    expect(body.rate).toBe(0.04);
    expect(body.amount).toBeNull();
  });

  it("nulls rate for a FLAT row even if a stale non-null rate is sitting on the row", () => {
    const row: SurchargeRow = { ...baseRow, kind: "FLAT", rate: 0.04, amount: 5 };
    const body = buildSurchargeBody(row, {});
    expect(body.kind).toBe("FLAT");
    expect(body.amount).toBe(5);
    expect(body.rate).toBeNull();
  });

  it("a patch that flips kind nulls the newly-forbidden field even though the patch never touched it", () => {
    // The exact "kind flip paired with the newly-visible field" flow the page's setKindLocal +
    // save rely on: flipping PERCENT -> FLAT and supplying only the new amount must not resurrect
    // the old rate sitting on the row.
    const flippedToFlat = buildSurchargeBody(baseRow, { kind: "FLAT", amount: 5 });
    expect(flippedToFlat.kind).toBe("FLAT");
    expect(flippedToFlat.amount).toBe(5);
    expect(flippedToFlat.rate).toBeNull();

    const flatRow: SurchargeRow = { ...baseRow, kind: "FLAT", rate: null, amount: 5 };
    const flippedToPercent = buildSurchargeBody(flatRow, { kind: "PERCENT", rate: 0.05 });
    expect(flippedToPercent.kind).toBe("PERCENT");
    expect(flippedToPercent.rate).toBe(0.05);
    expect(flippedToPercent.amount).toBeNull();
  });

  it("accepts a raw decimal string for rate/amount/minimumAmount without touching it", () => {
    const body = buildSurchargeBody(baseRow, { minimumAmount: "12.34" });
    expect(body.minimumAmount).toBe("12.34");
  });
});
