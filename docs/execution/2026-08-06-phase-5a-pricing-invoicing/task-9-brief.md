### Task 9: `pricing.ts` — the pure resolution engine

> **Two things carried in from Task 4's review (2026-08-06).**
>
> 1. **There is no effective dating on price rows.** `PartPrice` has no effective-from/to columns
>    and never did. Do not build date-window selection, and do not assume a price row can be
>    scheduled. What guarantees a deterministic winner is the **live partial unique
>    `(partId, processStepCodeId)`** — exactly one live row per operation per part — plus explicit
>    `orderBy` on the rows (`position asc, id asc`) and on their breaks (`threshold asc`), both
>    already in `listPartPrices`. Rely on those, and do not re-derive an ordering of your own.
> 2. **A row's breaks can predate a change to its basis.** `updatePartPrice` permits moving a row
>    among the non-LOT units while live breaks exist, and `threshold` is expressed in the parent
>    row's price-per unit — so a stored threshold may have been entered under a different unit
>    than the row now carries. Task 5 owns the UI half; decide here what the engine does when it
>    meets such a row, and make the choice explicit in the code rather than implicit in the
>    arithmetic.

**Files:**
- Create: `src/server/pricing.ts`
- Test: `tests/pricing.test.ts`

**Interfaces:**
- Consumes: type-only imports of `PricePerValue` (`src/lib/part-constants.ts`) and the Task 1 constants. **Nothing else.** No Prisma, no `./db`, no other `src/server/` module — this module must stay importable with zero side effects, and its test file must not touch the database.
- Produces:
```ts
// src/server/pricing.ts
export type PriceBreakInput = { threshold: number; price: number };
export type PriceRowInput = {
  processStepCodeId: string; stepCode: string; stepName: string; position: number;
  setupCharge: number | null; unitPrice: number | null; minimumCharge: number | null;
  pricePer: PricePerValue; breaks: PriceBreakInput[];
  glAccountId: string | null; glAccountName: string;
};
export type OrderLineInput = {
  orderLineId: string; position: number;
  partNumber: string; partName: string; partDescription: string; eachWeight: number;
  shippedQty: number; shippedWeight: number;
  prices: PriceRowInput[];
};
export type SurchargeInput = {
  surchargeId: string; name: string; kind: SurchargeKindValue;
  rate: number | null; amount: number | null; minimumAmount: number | null;
  scope: SurchargeScopeValue; stepCodeIds: string[]; position: number;
  glAccountId: string | null; glAccountName: string;
};
export type ChargeInput = { orderChargeId: string; position: number; description: string; amount: number | null };
export type GlRef = { glAccountId: string | null; glAccountName: string };
export type PricingInput = {
  lines: OrderLineInput[];
  surcharges: SurchargeInput[];
  charges: ChargeInput[];
  freight: (GlRef & { amount: number }) | null;
  cert: (GlRef & { amount: number; description: string }) | null;
  tax: (GlRef & { rate: number }) | null;
};
export type ComputedLine = {
  key: string; parentKey: string | null; kind: InvoiceLineKindValue;
  orderLineId: string | null; processStepCodeId: string | null;
  surchargeId: string | null; orderChargeId: string | null;
  glAccountId: string | null; glAccountName: string;
  partNumber: string; partName: string; partDescription: string; description: string;
  qty: number | null; weight: number | null; eachWeight: number | null;
  pricePer: PricePerValue | null;
  unitPrice: number | null; setupCharge: number | null; minimumCharge: number | null;
  breakThreshold: number | null; minimumApplied: boolean;
  rate: number | null; priceSource: PriceSourceValue | null; needsPrice: boolean;
  amount: number;
};
export type PricingResult = {
  lines: ComputedLine[];
  subtotal: number; surchargeTotal: number; chargeTotal: number;
  certTotal: number; freightTotal: number; taxTotal: number; total: number;
};
export function roundCents(value: number): number;
export function selectBreak(row: PriceRowInput, qty: number, weight: number): PriceBreakInput | null;
export function priceOrder(input: PricingInput): PricingResult;
```

- [ ] **Step 1: Write the failing tests** `tests/pricing.test.ts`. **No `truncateAll`, no `prisma` import** — this file is pure unit tests. Start with the golden case, which is the owner's own invoice:

```ts
import { describe, it, expect } from "vitest";
import { priceOrder, selectBreak, roundCents, type PricingInput, type PriceRowInput } from "@/server/pricing";

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
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/pricing.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/pricing.ts`.** The whole module computes in **integer cents and ten-thousandths**, converting to dollars only at the boundary — `144 × 6.51` is `937.4400000000001` in IEEE 754 doubles, and this is legal paper:

```ts
// Pure: plain data in, computed lines out. No Prisma, no I/O, no imports from ./ — this module
// must stay importable with zero side effects, which is what lets tests/pricing.test.ts run
// without a database and makes the math reviewable in one sitting.
//
// Money never passes through a float multiplication. Prices are scaled to ten-thousandths and
// quantities/weights to their own integer units, the products are integers, and the single
// division back to cents rounds half away from zero. `144 × 6.51 = 937.4400000000001` in IEEE
// 754; the invoice says $937.44.
import type { PricePerValue } from "../lib/part-constants";
import type {
  InvoiceLineKindValue, PriceSourceValue, SurchargeKindValue, SurchargeScopeValue,
} from "../lib/invoice-constants";

// …the exported types from the Interfaces block above…

/** `numerator / divisor`, rounded half away from zero, in integers. */
function divideRound(numerator: number, divisor: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  return sign * Math.floor((n * 2 + divisor) / (divisor * 2));
}

/** Half away from zero, to cents. The `1 + Number.EPSILON` lift is what stops a value that is
 *  a hair BELOW a half-cent purely through float error (937.4399999999999) rounding down. */
export function roundCents(value: number): number {
  const scaled = Math.abs(value) * 100 * (1 + Number.EPSILON);
  const cents = Math.round(scaled);
  return (value < 0 ? -cents : cents) / 100;
}

/** The value a break threshold is compared against: weight for an LB row, quantity for every
 *  other unit (owner ruling 2026-08-01 — the break basis follows the row's price-per unit).
 *  A LOT row can never reach here with breaks: they are refused at entry (part-prices.ts). */
function breakBasis(pricePer: PricePerValue, qty: number, weight: number): number {
  return pricePer === "LB" ? weight : qty;
}

export function selectBreak(row: PriceRowInput, qty: number, weight: number): PriceBreakInput | null {
  const basis = breakBasis(row.pricePer, qty, weight);
  let best: PriceBreakInput | null = null;
  for (const b of row.breaks) {
    if (b.threshold > basis) continue;
    if (best === null || b.threshold > best.threshold) best = b;
  }
  return best;
}

/** Extended amount in CENTS. `price` carries 4 decimals, `qty` is an integer, `weight` 2. */
function extendedCents(pricePer: PricePerValue, qty: number, weight: number, price: number): number {
  const p = Math.round(price * 10_000);
  switch (pricePer) {
    case "EACH":     return divideRound(qty * p, 100);
    case "PER_100":  return divideRound(qty * p, 100 * 100);
    case "PER_1000": return divideRound(qty * p, 100 * 1_000);
    case "LB":       return divideRound(Math.round(weight * 100) * p, 100 * 100);
    case "LOT":      return divideRound(p, 100);
  }
}
```

  `priceOrder` then composes, in exactly this order (the test above pins it):

  1. For each `line` in `position` order: a **`PART`** line — quantities, part identity, `amount: 0`, no GL. Then, for each of that line's `prices` in `position` order, an **`OPERATION`** line with `parentKey` set to the part line's key. A line with **no** price rows still gets one `OPERATION` line: `amount: 0`, `needsPrice: true`, `description: "Needs price"`, every price field null. A row with `unitPrice == null && minimumCharge == null` is likewise `needsPrice`.
     `amount = max(extendedCents, minimumCents) + setupCents`, with `minimumApplied` recorded when the floor won and `breakThreshold` recording which break did.
  2. **`SURCHARGE`** lines, in surcharge `position` order. Base = the sum of `OPERATION` line cents whose `processStepCodeId` passes the scope filter (`ALL` → all; `INCLUDE` → in `stepCodeIds`; `EXCLUDE` → not in it). **If no operation line qualifies, emit no line at all** — a minimum must not conjure a surcharge onto an invoice the surcharge does not apply to. `PERCENT` → `divideRound(base * Math.round(rate * 1e6), 1e6)`; `FLAT` → the amount in cents; then floored at `minimumAmount`. `rate` is snapshotted onto the line.
  3. **`FREIGHT`**, when `input.freight` is present — one line, description `"Freight"`.
  4. **`CHARGE`** lines, one per `charges` entry in `position` order; `amount: null` → `amount: 0, needsPrice: true`.
  5. **`CERT`**, when `input.cert` is present.
  6. **`TAX`**, when `input.tax` is present — base = operations + surcharges + charges + cert **in cents**, freight excluded; `rate` snapshotted.

  Totals are sums of the already-rounded line amounts, per bucket, and `total` is the sum of those buckets. `key` is `` `${kind}-${index}` `` — stable within one computation and only ever used to wire `parentLineId` when the caller writes rows.

- [ ] **Step 4: Run the tests** — `npx vitest run tests/pricing.test.ts`. Expected: PASS, all of them.

- [ ] **Step 5: Prove the module really is pure** — add one test asserting it, so a future edit that reaches for Prisma fails here rather than in production:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

it("imports nothing from the server or the database", () => {
  const src = readFileSync(join(process.cwd(), "src/server/pricing.ts"), "utf8");
  const imports = [...src.matchAll(/^import\s+(?:type\s+)?.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  expect(imports.every((i) => i.startsWith("../lib/"))).toBe(true);
});
```

- [ ] **Step 6: Gates + commit** — `feat: pure pricing engine — per-operation math, breaks, minimums, surcharges, tax`

---

