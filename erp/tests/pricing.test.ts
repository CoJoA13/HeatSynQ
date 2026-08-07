import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  priceOrder, selectBreak, roundCents,
  type PricingInput, type PriceRowInput, type OrderLineInput, type SurchargeInput,
} from "@/server/pricing";

// Pure module, no DB: every case here is arithmetic over plain data. There is deliberately no
// `truncateAll` and no `prisma` import in this file — the last test asserts the module itself
// stays importable without either.

const GL = { glAccountId: "gl1", glAccountName: "4010" };

function row(over: Partial<PriceRowInput> = {}): PriceRowInput {
  return {
    processStepCodeId: "sc1", stepCode: "AUST", stepName: "Austemper", position: 1,
    setupCharge: null, unitPrice: 6.51, minimumCharge: 600, pricePer: "EACH", breaks: [],
    ...GL, ...over,
  };
}

function input(over: Partial<PricingInput> = {}): PricingInput {
  return {
    lines: [{
      orderLineId: "ol1", position: 1,
      partNumber: "A16-21591-000", partName: "EQUALIZER-RR SUSP", partDescription: "",
      eachWeight: 21, shippedQty: 144, shippedWeight: 3024, prices: [row()],
    }],
    surcharges: [], charges: [], freight: null, cert: null, tax: null,
    ...over,
  };
}

describe("pricing — the sample invoice", () => {
  it("reproduces docs/samples/Invoice Sample.pdf exactly", () => {
    const result = priceOrder(input({
      surcharges: [{
        surchargeId: "s1", name: "EnergySur", kind: "PERCENT", rate: 0.04,
        amount: null, minimumAmount: null, scope: "ALL", stepCodeIds: [], position: 1,
        glAccountId: "gl2", glAccountName: "4200",
      }],
    }));
    const operation = result.lines.find((l) => l.kind === "OPERATION")!;
    expect(operation.amount).toBe(937.44);          // 144 × 6.51, above the 600 minimum
    expect(operation.minimumApplied).toBe(false);
    const surcharge = result.lines.find((l) => l.kind === "SURCHARGE")!;
    expect(surcharge.amount).toBe(37.5);            // 4% of 937.44 = 37.4976, half-up
    expect(result.subtotal).toBe(937.44);
    expect(result.total).toBe(974.94);
  });

  it("emits a PART line carrying quantities and no money", () => {
    const part = priceOrder(input()).lines.find((l) => l.kind === "PART")!;
    expect(part.qty).toBe(144);
    expect(part.weight).toBe(3024);
    expect(part.eachWeight).toBe(21);
    expect(part.amount).toBe(0);
    expect(part.parentKey).toBeNull();
  });

  it("hangs OPERATION lines off their PART line", () => {
    const { lines } = priceOrder(input());
    const part = lines.find((l) => l.kind === "PART")!;
    const op = lines.find((l) => l.kind === "OPERATION")!;
    expect(op.parentKey).toBe(part.key);
  });
});

describe("pricing — price-per bases", () => {
  const bases: [PriceRowInput["pricePer"], number][] = [
    ["EACH", 937.44],       // 144 × 6.51
    ["PER_100", 9.37],      // 144/100 × 6.51 = 9.3744 → 9.37
    ["PER_1000", 0.94],     // 144/1000 × 6.51 = 0.937 → 0.94
    ["LB", 19686.24],       // 3024 × 6.51
    ["LOT", 6.51],          // flat
  ];
  for (const [pricePer, expected] of bases) {
    it(`prices ${pricePer}`, () => {
      const result = priceOrder(input({
        lines: [{ ...input().lines[0], prices: [row({ pricePer, minimumCharge: null })] }],
      }));
      expect(result.lines.find((l) => l.kind === "OPERATION")!.amount).toBe(expected);
    });
  }
});

describe("pricing — breaks", () => {
  const breaks = [{ threshold: 100, price: 6.0 }, { threshold: 500, price: 5.0 }];

  it("takes the highest threshold at or below the basis", () => {
    expect(selectBreak(row({ breaks }), 99, 0)).toBeNull();
    expect(selectBreak(row({ breaks }), 100, 0)!.price).toBe(6);   // exactly on
    expect(selectBreak(row({ breaks }), 499, 0)!.price).toBe(6);
    expect(selectBreak(row({ breaks }), 500, 0)!.price).toBe(5);   // exactly on
    expect(selectBreak(row({ breaks }), 100000, 0)!.price).toBe(5);
  });

  it("compares an LB row against weight, every other unit against quantity", () => {
    expect(selectBreak(row({ breaks, pricePer: "LB" }), 10, 600)!.price).toBe(5);
    expect(selectBreak(row({ breaks, pricePer: "EACH" }), 10, 600)).toBeNull();
  });

  it("records the winning threshold on the line", () => {
    const result = priceOrder(input({
      lines: [{ ...input().lines[0], prices: [row({ breaks, minimumCharge: null })] }],
    }));
    const op = result.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.breakThreshold).toBe(100);
    expect(op.unitPrice).toBe(6);
    expect(op.amount).toBe(864);   // 144 × 6.00
  });
});

describe("pricing — minimum and setup", () => {
  it("floors at the minimum and flags it", () => {
    const result = priceOrder(input({
      lines: [{ ...input().lines[0], shippedQty: 10, shippedWeight: 210,
                prices: [row({ minimumCharge: 600 })] }],
    }));
    const op = result.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.amount).toBe(600);         // 10 × 6.51 = 65.10, floored
    expect(op.minimumApplied).toBe(true);
  });

  it("adds setup ON TOP of the minimum, never inside it (ruling 13)", () => {
    const result = priceOrder(input({
      lines: [{ ...input().lines[0], shippedQty: 10, shippedWeight: 210,
                prices: [row({ minimumCharge: 600, setupCharge: 75 })] }],
    }));
    expect(result.lines.find((l) => l.kind === "OPERATION")!.amount).toBe(675);
  });
});

describe("pricing — needs price", () => {
  it("bills a line with no price rows at zero and flags it", () => {
    const result = priceOrder(input({ lines: [{ ...input().lines[0], prices: [] }] }));
    const op = result.lines.find((l) => l.kind === "OPERATION")!;
    expect(op.amount).toBe(0);
    expect(op.needsPrice).toBe(true);
    expect(op.processStepCodeId).toBeNull();
  });

  it("flags a priced row carrying neither a unit price nor a minimum", () => {
    const result = priceOrder(input({
      lines: [{ ...input().lines[0], prices: [row({ unitPrice: null, minimumCharge: null })] }],
    }));
    expect(result.lines.find((l) => l.kind === "OPERATION")!.needsPrice).toBe(true);
  });

  it("flags an extra charge with no amount", () => {
    const result = priceOrder(input({
      charges: [{ orderChargeId: "c1", position: 1, description: "Rush", amount: null }],
    }));
    const charge = result.lines.find((l) => l.kind === "CHARGE")!;
    expect(charge.needsPrice).toBe(true);
    expect(charge.amount).toBe(0);
  });
});

describe("pricing — surcharge scope", () => {
  const twoOps = {
    ...input().lines[0],
    prices: [
      row({ processStepCodeId: "sc1", stepCode: "AUST", unitPrice: 1, minimumCharge: null, position: 1 }),
      row({ processStepCodeId: "sc2", stepCode: "WASH", unitPrice: 2, minimumCharge: null, position: 2 }),
    ],
  };
  const surcharge = (over: object) => ({
    surchargeId: "s1", name: "S", kind: "PERCENT" as const, rate: 0.1,
    amount: null, minimumAmount: null, scope: "ALL" as const, stepCodeIds: [], position: 1,
    glAccountId: null, glAccountName: "", ...over,
  });

  it("ALL bills every operation line", () => {
    const r = priceOrder(input({ lines: [twoOps], surcharges: [surcharge({})] }));
    expect(r.surchargeTotal).toBe(43.2);        // 10% of (144 + 288)
  });

  it("INCLUDE bills only the listed step codes", () => {
    const r = priceOrder(input({ lines: [twoOps],
      surcharges: [surcharge({ scope: "INCLUDE", stepCodeIds: ["sc2"] })] }));
    expect(r.surchargeTotal).toBe(28.8);        // 10% of 288
  });

  it("EXCLUDE bills everything but the listed step codes", () => {
    const r = priceOrder(input({ lines: [twoOps],
      surcharges: [surcharge({ scope: "EXCLUDE", stepCodeIds: ["sc2"] })] }));
    expect(r.surchargeTotal).toBe(14.4);        // 10% of 144
  });

  it("applies a flat amount and floors at the minimum", () => {
    const flat = priceOrder(input({ lines: [twoOps],
      surcharges: [surcharge({ kind: "FLAT", rate: null, amount: 5 })] }));
    expect(flat.surchargeTotal).toBe(5);
    const floored = priceOrder(input({ lines: [twoOps],
      surcharges: [surcharge({ rate: 0.001, minimumAmount: 25 })] }));
    expect(floored.surchargeTotal).toBe(25);
  });

  it("emits nothing when no operation line qualifies, even with a minimum", () => {
    const r = priceOrder(input({ lines: [twoOps],
      surcharges: [surcharge({ scope: "INCLUDE", stepCodeIds: ["sc9"], minimumAmount: 25 })] }));
    expect(r.lines.some((l) => l.kind === "SURCHARGE")).toBe(false);
    expect(r.surchargeTotal).toBe(0);
  });
});

describe("pricing — tax", () => {
  it("taxes operations, surcharges, charges and cert — never freight", () => {
    const r = priceOrder(input({
      lines: [{ ...input().lines[0], prices: [row({ unitPrice: 1, minimumCharge: null })] }],  // 144.00
      surcharges: [], charges: [{ orderChargeId: "c1", position: 1, description: "Rush", amount: 10 }],
      cert: { amount: 25, description: "Certification", ...GL },
      freight: { amount: 100, ...GL },
      tax: { rate: 0.04, ...GL },
    }));
    expect(r.taxTotal).toBe(7.16);        // 4% of (144 + 10 + 25) = 7.16 — freight excluded
    expect(r.total).toBe(286.16);         // 144 + 10 + 25 + 100 + 7.16
  });

  it("emits no TAX line when there is no tax config", () => {
    expect(priceOrder(input()).lines.some((l) => l.kind === "TAX")).toBe(false);
  });
});

describe("roundCents", () => {
  it("rounds half away from zero and survives float error", () => {
    expect(roundCents(937.4400000000001)).toBe(937.44);
    expect(roundCents(37.4976)).toBe(37.5);
    expect(roundCents(0.125)).toBe(0.13);
    expect(roundCents(-0.125)).toBe(-0.13);
    expect(roundCents(0.124999999)).toBe(0.12);
  });
});

describe("pricing — line ordering", () => {
  it("orders PART → its OPERATIONs → SURCHARGE → FREIGHT → CHARGE → CERT → TAX", () => {
    const r = priceOrder(input({
      surcharges: [{ surchargeId: "s1", name: "S", kind: "FLAT", rate: null, amount: 5,
                     minimumAmount: null, scope: "ALL", stepCodeIds: [], position: 1,
                     glAccountId: null, glAccountName: "" }],
      charges: [{ orderChargeId: "c1", position: 1, description: "Rush", amount: 10 }],
      cert: { amount: 25, description: "Certification", ...GL },
      freight: { amount: 100, ...GL },
      tax: { rate: 0.04, ...GL },
    }));
    expect(r.lines.map((l) => l.kind)).toEqual(
      ["PART", "OPERATION", "SURCHARGE", "FREIGHT", "CHARGE", "CERT", "TAX"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Everything below is this task's own coverage, on top of the plan's. Each case is written so a
// *plausible* wrong implementation fails it: rounding the unit price before multiplying, banker's
// rounding, re-rounding a sum of rounded lines, compounding one surcharge onto another, or reading
// a break threshold in a unit the row no longer carries.
// ---------------------------------------------------------------------------------------------

function line(over: Partial<OrderLineInput> = {}): OrderLineInput {
  return { ...input().lines[0], ...over };
}

function sur(over: Partial<SurchargeInput> = {}): SurchargeInput {
  return {
    surchargeId: "s1", name: "EnergySur", kind: "PERCENT", rate: 0.1, amount: null,
    minimumAmount: null, scope: "ALL", stepCodeIds: [], position: 1,
    glAccountId: "gl2", glAccountName: "4200", ...over,
  };
}

/** The one OPERATION line of a single-priced-row order. */
function op(over: Partial<PriceRowInput>, lineOver: Partial<OrderLineInput> = {}) {
  const r = priceOrder(input({ lines: [line({ ...lineOver, prices: [row(over)] })] }));
  return r.lines.find((l) => l.kind === "OPERATION")!;
}

describe("pricing — rounding happens once, at the extension", () => {
  // [what it is, pricePer, qty, weight, unit price, cents]  — the comment names the wrong answer
  // each case discriminates against.
  const cases: [string, PriceRowInput["pricePer"], number, number, number, number][] = [
    ["4-decimal price × qty",     "EACH", 7, 0, 0.3333, 2.33],        // per-unit rounding → 2.31
    ["half a cent lands up",      "EACH", 3, 0, 6.515, 19.55],        // per-unit rounding → 19.53/19.56
    ["exactly 2.5 cents",         "EACH", 1, 0, 0.025, 0.03],         // banker's → 0.02
    ["exactly half a cent",       "EACH", 1, 0, 0.005, 0.01],         // banker's → 0.00
    ["per-100 half cent",         "PER_100", 50, 0, 0.05, 0.03],      // banker's → 0.02
    ["per-lb half cent",          "LB", 0, 0.5, 0.05, 0.03],          // banker's → 0.02
    ["per-lb fractional weight",  "LB", 0, 1234.56, 2.5, 3086.4],     // float drift → 3086.3999…
    ["a million pieces",          "EACH", 1_000_000, 0, 6.51, 6_510_000],
  ];
  for (const [what, pricePer, qty, weight, unitPrice, expected] of cases) {
    it(what, () => {
      expect(op({ pricePer, unitPrice, minimumCharge: null },
                { shippedQty: qty, shippedWeight: weight }).amount).toBe(expected);
    });
  }
});

describe("pricing — totals sum already-rounded lines", () => {
  it("never re-rounds the sum", () => {
    // Three operations at 0.125 each: each line rounds to 0.13, so the subtotal is 0.39.
    // Summing first and rounding once would say 0.38.
    const r = priceOrder(input({
      lines: [line({
        shippedQty: 1,
        prices: [1, 2, 3].map((n) => row({
          processStepCodeId: `sc${n}`, position: n, unitPrice: 0.125, minimumCharge: null,
        })),
      })],
    }));
    expect(r.lines.filter((l) => l.kind === "OPERATION").map((l) => l.amount)).toEqual([0.13, 0.13, 0.13]);
    expect(r.subtotal).toBe(0.39);
    expect(r.total).toBe(0.39);
  });
});

describe("pricing — the minimum floor", () => {
  it("does not claim the floor won on a tie", () => {
    const o = op({ unitPrice: 6, minimumCharge: 600 }, { shippedQty: 100 });   // 600.00 exactly
    expect(o.amount).toBe(600);
    expect(o.minimumApplied).toBe(false);
  });

  it("floors one cent under and leaves one cent over alone", () => {
    expect(op({ unitPrice: 5.9999, minimumCharge: 600 }, { shippedQty: 100 }))
      .toMatchObject({ amount: 600, minimumApplied: true });                   // 599.99 floored
    expect(op({ unitPrice: 6.0001, minimumCharge: 600 }, { shippedQty: 100 }))
      .toMatchObject({ amount: 600.01, minimumApplied: false });
  });

  it("bills the minimum plus setup at zero shipped quantity", () => {
    // Task 11 only feeds lines with a non-zero net shipped total, so this is the formula stated
    // (§5, ruling 13) rather than a carve-out: max(0, minimum) + setup.
    expect(op({ minimumCharge: 600, setupCharge: 75 }, { shippedQty: 0, shippedWeight: 0 }))
      .toMatchObject({ amount: 675, minimumApplied: true });
    expect(op({ minimumCharge: null, setupCharge: 75 }, { shippedQty: 0, shippedWeight: 0 }))
      .toMatchObject({ amount: 75, minimumApplied: false });
  });
});

describe("pricing — what a needs-price line still bills", () => {
  it("keeps a setup charge the operator typed, and flags the row", () => {
    // needsPrice is a FLAG, not a suppression: dropping money already entered would be the
    // silent failure. The warning names the row; the setup still bills.
    const o = op({ unitPrice: null, minimumCharge: null, setupCharge: 75 });
    expect(o.needsPrice).toBe(true);
    expect(o.amount).toBe(75);
  });

  it("bills a minimum-only row at its minimum without flagging it", () => {
    const o = op({ unitPrice: null, minimumCharge: 600 });
    expect(o.needsPrice).toBe(false);
    expect(o.amount).toBe(600);
    expect(o.minimumApplied).toBe(true);
  });

  it("empties every price field on the no-rows line", () => {
    const o = priceOrder(input({ lines: [line({ prices: [] })] }))
      .lines.find((l) => l.kind === "OPERATION")!;
    expect(o).toMatchObject({
      description: "Needs price", processStepCodeId: null, pricePer: null, unitPrice: null,
      setupCharge: null, minimumCharge: null, breakThreshold: null, minimumApplied: false,
      priceSource: null, glAccountId: null, glAccountName: "", amount: 0,
    });
  });
});

describe("pricing — a break threshold reads in the unit the row carries NOW", () => {
  // Owner ruling (2C-2 spec §3.1): a per-lb row's thresholds are POUNDS; per-each / per-100 /
  // per-1000 rows' thresholds are PIECES. `updatePartPrice` lets a live row move among the
  // non-LOT units while its breaks stay put, so a stored threshold can predate its row's current
  // basis. The engine never converts and never remembers the unit a threshold was typed under.
  const breaks = [{ threshold: 100, price: 6.0 }, { threshold: 500, price: 5.0 }];

  it("counts pieces on a PER_100 row, not hundreds", () => {
    expect(selectBreak(row({ breaks, pricePer: "PER_100" }), 500, 0)!.price).toBe(5);
    expect(selectBreak(row({ breaks, pricePer: "PER_100" }), 99, 0)).toBeNull();
  });

  it("counts pieces on a PER_1000 row, not thousands", () => {
    expect(selectBreak(row({ breaks, pricePer: "PER_1000" }), 500, 0)!.price).toBe(5);
  });

  it("re-reads the same thresholds as pounds once the row moves to LB", () => {
    const stale = { breaks, unitPrice: 9, minimumCharge: null };
    expect(selectBreak(row({ ...stale, pricePer: "EACH" }), 600, 10)!.price).toBe(5);
    expect(selectBreak(row({ ...stale, pricePer: "LB" }), 600, 10)).toBeNull();
    // …and the arithmetic follows the same choice, not just the selector.
    expect(op({ ...stale, pricePer: "EACH" }, { shippedQty: 600, shippedWeight: 10 }).unitPrice).toBe(5);
    expect(op({ ...stale, pricePer: "LB" }, { shippedQty: 600, shippedWeight: 10 }).unitPrice).toBe(9);
  });

  it("prices a PER_100 row off the break it selected", () => {
    // 500 pieces clears the 500 threshold → $5.00 per 100 → 5 × 5.00 = 25.00
    expect(op({ breaks, pricePer: "PER_100", minimumCharge: null }, { shippedQty: 500 }))
      .toMatchObject({ amount: 25, unitPrice: 5, breakThreshold: 500 });
  });

  it("selects nothing from an empty break list, and the single break it has", () => {
    expect(selectBreak(row({ breaks: [] }), 1_000_000, 1_000_000)).toBeNull();
    expect(selectBreak(row({ breaks: [{ threshold: 144, price: 3 }] }), 144, 0)!.price).toBe(3);
    expect(selectBreak(row({ breaks: [{ threshold: 144, price: 3 }] }), 143, 0)).toBeNull();
  });
});

describe("pricing — how surcharges compose", () => {
  const oneHundred = line({ shippedQty: 100, prices: [row({ unitPrice: 1, minimumCharge: null })] });

  it("computes every surcharge on the operations alone — they never compound", () => {
    const r = priceOrder(input({
      lines: [oneHundred],
      surcharges: [sur({ surchargeId: "s1" }), sur({ surchargeId: "s2", name: "Second", position: 2 })],
    }));
    // Compounding would make the second 10% of 110.00 = 11.00.
    expect(r.lines.filter((l) => l.kind === "SURCHARGE").map((l) => l.amount)).toEqual([10, 10]);
    expect(r.surchargeTotal).toBe(20);
  });

  it("computes on the operation amount as billed — minimum and setup included", () => {
    const r = priceOrder(input({
      lines: [line({ shippedQty: 10, prices: [row({ minimumCharge: 600, setupCharge: 75 })] })],
      surcharges: [sur()],
    }));
    expect(r.subtotal).toBe(675);
    expect(r.surchargeTotal).toBe(67.5);        // 10% of 675, not of 65.10
  });

  it("ignores freight, charges and the certification charge", () => {
    const r = priceOrder(input({
      lines: [oneHundred],
      surcharges: [sur()],
      charges: [{ orderChargeId: "c1", position: 1, description: "Rush", amount: 500 }],
      cert: { amount: 25, description: "Certification", ...GL },
      freight: { amount: 100, ...GL },
    }));
    expect(r.surchargeTotal).toBe(10);          // 10% of 100.00 only
  });

  it("emits a qualifying surcharge even when the qualifying operations bill nothing", () => {
    // The rule is qualification, not a non-zero base: an unpriced operation still IS an operation
    // line, so an ALL (or EXCLUDE) surcharge applies to it and its minimum stands.
    const unpriced = input({ lines: [line({ prices: [] })], surcharges: [sur({ minimumAmount: 25 })] });
    expect(priceOrder(unpriced).surchargeTotal).toBe(25);
    expect(priceOrder({ ...unpriced, surcharges: [sur({ scope: "EXCLUDE", stepCodeIds: ["sc1"], minimumAmount: 25 })] })
      .surchargeTotal).toBe(25);
    // INCLUDE can never match a line with no step code at all.
    const included = priceOrder({
      ...unpriced, surcharges: [sur({ scope: "INCLUDE", stepCodeIds: ["sc1"], minimumAmount: 25 })],
    });
    expect(included.lines.some((l) => l.kind === "SURCHARGE")).toBe(false);
    expect(included.surchargeTotal).toBe(0);
  });

  it("snapshots the percent rate and leaves it null on a flat surcharge", () => {
    const percent = priceOrder(input({ lines: [oneHundred], surcharges: [sur({ rate: 0.0425 })] }));
    expect(percent.lines.find((l) => l.kind === "SURCHARGE")!.rate).toBe(0.0425);
    expect(percent.surchargeTotal).toBe(4.25);
    const flat = priceOrder(input({
      lines: [oneHundred], surcharges: [sur({ kind: "FLAT", rate: null, amount: 5 })] }));
    expect(flat.lines.find((l) => l.kind === "SURCHARGE")!.rate).toBeNull();
  });
});

describe("pricing — how tax composes", () => {
  const oneHundred = line({ shippedQty: 100, prices: [row({ unitPrice: 1, minimumCharge: null })] });

  it("includes surcharges in its base", () => {
    const r = priceOrder(input({
      lines: [oneHundred], surcharges: [sur()], tax: { rate: 0.1, ...GL },
    }));
    expect(r.taxTotal).toBe(11);                // 10% of (100.00 + 10.00)
    expect(r.total).toBe(121);
  });

  it("rounds its own half cent away from zero", () => {
    // 100.24 × 6.25% = 6.2650 → 6.27 (banker's would say 6.26).
    const r = priceOrder(input({
      lines: [line({ shippedQty: 8, prices: [row({ unitPrice: 12.53, minimumCharge: null })] })],
      tax: { rate: 0.0625, ...GL },
    }));
    expect(r.subtotal).toBe(100.24);
    expect(r.taxTotal).toBe(6.27);
    expect(r.lines.find((l) => l.kind === "TAX")!.rate).toBe(0.0625);
  });
});

describe("pricing — what each line snapshots", () => {
  const full = () => priceOrder(input({
    lines: [line({ prices: [row({ setupCharge: 75 })] })],
    surcharges: [sur({ glAccountId: "gl2", glAccountName: "4200" })],
    charges: [{ orderChargeId: "c1", position: 1, description: "Rush", amount: 10 }],
    cert: { amount: 25, description: "Certification", glAccountId: "gl3", glAccountName: "4300" },
    freight: { amount: 100, glAccountId: "gl4", glAccountName: "4400" },
    tax: { rate: 0.04, glAccountId: "gl5", glAccountName: "2200" },
  }));

  it("gives every line a unique key and hangs operations off their own part", () => {
    const r = priceOrder(input({
      lines: [
        line({ orderLineId: "ol1", partNumber: "P1" }),
        line({ orderLineId: "ol2", partNumber: "P2", prices: [row({ processStepCodeId: "sc2" })] }),
      ],
    }));
    expect(new Set(r.lines.map((l) => l.key)).size).toBe(r.lines.length);
    const parts = r.lines.filter((l) => l.kind === "PART");
    const ops = r.lines.filter((l) => l.kind === "OPERATION");
    expect(r.lines.map((l) => l.kind)).toEqual(["PART", "OPERATION", "PART", "OPERATION"]);
    expect(ops.map((o) => o.parentKey)).toEqual([parts[0].key, parts[1].key]);
    expect(ops.every((o) => o.orderLineId !== null)).toBe(true);
  });

  it("labels each line the way the paper reads it", () => {
    expect(full().lines.map((l) => l.description)).toEqual(
      ["", "Austemper", "EnergySur", "Freight", "Rush", "Certification", "Sales tax"]);
  });

  it("carries the GL account each revenue line posts to", () => {
    expect(full().lines.map((l) => [l.kind, l.glAccountName])).toEqual([
      ["PART", ""],            // the part line is quantities only — no money, no account
      ["OPERATION", "4010"],   // the step code's account, off the price row
      ["SURCHARGE", "4200"],
      ["FREIGHT", "4400"],
      ["CHARGE", ""],          // ChargeInput carries no GL — see the task report
      ["CERT", "4300"],
      ["TAX", "2200"],
    ]);
  });

  it("marks only a priced operation as sourced from a part price", () => {
    expect(full().lines.map((l) => l.priceSource)).toEqual(
      [null, "PART_PRICE", null, null, null, null, null]);
    expect(priceOrder(input({ lines: [line({ prices: [] })] }))
      .lines.map((l) => l.priceSource)).toEqual([null, null]);
  });

  it("snapshots the price inputs that explain an operation's amount", () => {
    const o = full().lines.find((l) => l.kind === "OPERATION")!;
    expect(o).toMatchObject({
      pricePer: "EACH", unitPrice: 6.51, setupCharge: 75, minimumCharge: 600,
      breakThreshold: null, processStepCodeId: "sc1", orderLineId: "ol1", surchargeId: null,
      orderChargeId: null, amount: 1012.44,                       // 937.44 + 75.00
    });
    // Quantities live on the PART line, once, and the OPERATION hangs off it.
    expect(o).toMatchObject({ qty: null, weight: null, eachWeight: null });
  });

  it("names the ids a written line needs to point back at", () => {
    const r = full();
    expect(r.lines.find((l) => l.kind === "SURCHARGE")!.surchargeId).toBe("s1");
    expect(r.lines.find((l) => l.kind === "CHARGE")!.orderChargeId).toBe("c1");
    expect(r.lines.find((l) => l.kind === "PART")!.orderLineId).toBe("ol1");
    expect(r.lines.filter((l) => !["PART", "OPERATION"].includes(l.kind))
      .every((l) => l.parentKey === null)).toBe(true);
  });

  it("bucket totals and the grand total agree", () => {
    const r = full();
    expect(r).toMatchObject({
      subtotal: 1012.44, surchargeTotal: 101.24, chargeTotal: 10, certTotal: 25, freightTotal: 100,
    });
    expect(r.taxTotal).toBe(45.95);   // 4% of (1012.44 + 101.24 + 10 + 25) = 45.9472
    expect(r.total).toBe(1294.63);
  });
});

describe("pricing — the caller's order is the paper order", () => {
  it("consumes each array as given and re-sorts nothing", () => {
    // `listPartPrices` / `listSurcharges` already order by `position asc, id asc`; re-deriving an
    // order here would be a second, competing rule (Task 4 review carry-in 1).
    const r = priceOrder({
      lines: [
        line({ orderLineId: "ol2", position: 9, partNumber: "P2" }),
        line({ orderLineId: "ol1", position: 1, partNumber: "P1",
               prices: [row({ processStepCodeId: "sc9", stepName: "Second", position: 9 }),
                        row({ processStepCodeId: "sc1", stepName: "First", position: 1 })] }),
      ],
      surcharges: [sur({ surchargeId: "s9", name: "Nine", position: 9 }),
                   sur({ surchargeId: "s1", name: "One", position: 1 })],
      charges: [{ orderChargeId: "c9", position: 9, description: "Nine", amount: 1 },
                { orderChargeId: "c1", position: 1, description: "One", amount: 1 }],
      freight: null, cert: null, tax: null,
    });
    expect(r.lines.filter((l) => l.kind === "PART").map((l) => l.partNumber)).toEqual(["P2", "P1"]);
    expect(r.lines.filter((l) => l.kind === "OPERATION").map((l) => l.description))
      .toEqual(["Austemper", "Second", "First"]);
    expect(r.lines.filter((l) => l.kind === "SURCHARGE").map((l) => l.description)).toEqual(["Nine", "One"]);
    expect(r.lines.filter((l) => l.kind === "CHARGE").map((l) => l.orderChargeId)).toEqual(["c9", "c1"]);
  });
});

describe("pricing — nothing to price", () => {
  it("returns no lines and zero totals", () => {
    const r = priceOrder({ lines: [], surcharges: [], charges: [], freight: null, cert: null, tax: null });
    expect(r.lines).toEqual([]);
    expect(r).toMatchObject({
      subtotal: 0, surchargeTotal: 0, chargeTotal: 0, certTotal: 0, freightTotal: 0, taxTotal: 0, total: 0,
    });
  });
});

describe("roundCents — the rest of its contract", () => {
  it("survives the classic float-representation cases", () => {
    expect(roundCents(2.675)).toBe(2.68);        // 2.675 is 2.67499999999999982 in IEEE 754
    expect(roundCents(1.005)).toBe(1.01);        // 1.005 × 100 is 100.49999999999999
    expect(roundCents(0)).toBe(0);
    expect(Math.abs(roundCents(-0.004))).toBe(0);
    expect(roundCents(-37.4976)).toBe(-37.5);    // credits are negative money
    expect(roundCents(1234.567)).toBe(1234.57);
  });
});

describe("pricing — the module is pure", () => {
  it("imports nothing from the server or the database", () => {
    const src = readFileSync(join(process.cwd(), "src/server/pricing.ts"), "utf8");
    const imports = [...src.matchAll(/^import\s+(?:type\s+)?.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((i) => i.startsWith("../lib/"))).toBe(true);
  });
});
