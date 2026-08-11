// Pure: plain data in, computed lines out. No Prisma, no I/O, no imports from ./ — this module
// must stay importable with zero side effects, which is what lets tests/pricing.test.ts run
// without a database and makes the math reviewable in one sitting.
//
// Money never passes through a float multiplication. Prices are scaled to ten-thousandths and
// quantities/weights to their own integer units, the products are integers, and the single
// division back to cents rounds half away from zero. `144 × 6.51 = 937.4400000000001` in IEEE
// 754; the invoice says $937.44.
//
// Three choices this module makes deliberately, because each is money and none is visible in the
// arithmetic on its own:
//
//   1. ROUNDING HAPPENS ONCE PER LINE, at the extension. The unit price keeps all four of its
//      decimals through the multiplication; only the product is rounded. Rounding the unit price
//      first and then multiplying is a different (wrong) number at quantity. Totals are then sums
//      of already-rounded line amounts — integer cents, so the sum is exact and never re-rounded.
//   2. A BREAK THRESHOLD IS READ IN THE UNIT THE ROW CARRIES NOW. Thresholds are pounds on an LB
//      row and pieces on every other unit (owner ruling, 2C-2 spec §3.1 — a per-100 row's breaks
//      are still counted in pieces). `updatePartPrice` lets a live row move among the non-LOT
//      units while its breaks stay put, so a stored threshold can predate its row's basis; the
//      engine does not convert it and does not remember the unit it was typed under. The row is
//      the single source of truth at compute time, and the only unit change that reinterprets a
//      threshold is one that crosses the LB boundary (Task 5 owns warning the user).
//   3. `needsPrice` IS A FLAG, NOT A SUPPRESSION. A row with no unit price and no minimum is
//      flagged, and whatever it *does* carry (a setup charge) still bills. Dropping money the
//      operator entered would be the silent failure §7.5 exists to prevent; the flag is how the
//      invoice says so out loud.
//
// There is no effective dating anywhere in here: `PartPrice` has no date columns, and what makes
// the winning row deterministic is the live partial unique `(partId, processStepCodeId)` plus the
// explicit `orderBy` upstream (`listPartPrices`, `listSurcharges`). This module therefore consumes
// every array in the order it is handed and re-sorts nothing — the `position` fields ride along as
// snapshot data. A second ordering rule here would compete with the first.
import type { PricePerValue } from "../lib/part-constants";
import type {
  InvoiceLineKindValue, PriceSourceValue, SurchargeKindValue, SurchargeScopeValue,
} from "../lib/invoice-constants";

export type PriceBreakInput = { threshold: number; price: number };
export type PriceRowInput = {
  processStepCodeId: string; stepCode: string; stepName: string; position: number;
  setupCharge: number | null; unitPrice: number | null; minimumCharge: number | null;
  pricePer: PricePerValue; breaks: PriceBreakInput[];
  glAccountId: string | null; glAccountName: string;
  // Phase 6 tier-1 pass-throughs (quoting spec §4.2). The engine does not DECIDE the source — it
  // emits what the row carries: the assembler stamps QUOTE + the quote number onto rows it built
  // from a quote line, and every part-price caller omits both (defaults PART_PRICE / null, so no
  // pre-Phase-6 caller changed). No math in this module reads either field.
  priceSource?: PriceSourceValue;
  sourceQuoteNumber?: number | null;
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
  rate: number | null; priceSource: PriceSourceValue | null; sourceQuoteNumber: number | null;
  needsPrice: boolean;
  amount: number;
};
export type PricingResult = {
  lines: ComputedLine[];
  subtotal: number; surchargeTotal: number; chargeTotal: number;
  certTotal: number; freightTotal: number; taxTotal: number; total: number;
};

/** Line labels the paper reads. `FREIGHT`/`TAX` have no caller-supplied description; the rest do. */
const FREIGHT_LABEL = "Freight";
const TAX_LABEL = "Sales tax";
const NEEDS_PRICE_LABEL = "Needs price";

/** `Surcharge.rate` and `BillingConfig.salesTaxRate` are `Decimal(9, 6)` — six decimals, so a rate
 *  scales to an integer by a million. Prices are `Decimal(12, 4)`, weights `Decimal(12, 2)`. */
const RATE_SCALE = 1_000_000;
const PRICE_SCALE = 10_000;

/** `numerator / divisor`, rounded half away from zero, in integers. */
function divideRound(numerator: number, divisor: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  return sign * Math.floor((n * 2 + divisor) / (divisor * 2));
}

/** Dollars → integer cents, half away from zero. The `1 + Number.EPSILON` lift is what stops a
 *  value that is a hair BELOW a half-cent purely through float error (937.4399999999999, or
 *  `1.005 * 100 === 100.49999999999999`) rounding down. */
function toCents(value: number): number {
  const scaled = Math.abs(value) * 100 * (1 + Number.EPSILON);
  const cents = Math.round(scaled);
  return value < 0 ? -cents : cents;
}

function fromCents(cents: number): number {
  return cents / 100;
}

/** Half away from zero, to cents. Exported for the callers that have to round a dollar figure
 *  they did not get from here (a hand-typed invoice line, a credit's negation).
 *
 *  Assumes its input already carries at most 2 decimal places of real precision (a dollar
 *  figure, not an arbitrary float) — the `1 + Number.EPSILON` lift in `toCents` that correctly
 *  nudges a value like `1.005 * 100 === 100.49999999999999` up to the next cent can, for a value
 *  representing an actual half-cent-minus-a-hair boundary a few ulps further out (e.g.
 *  `12.344999999999999`), round it the wrong way (12.35, not 12.34). Every value this module
 *  itself feeds `toCents` is a 2- or 4-decimal `Decimal` and never lands that close to a
 *  boundary; a caller passing in a computed float should round to cents before calling this. */
export function roundCents(value: number): number {
  return fromCents(toCents(value));
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
  const p = Math.round(price * PRICE_SCALE);
  switch (pricePer) {
    case "EACH":     return divideRound(qty * p, 100);
    case "PER_100":  return divideRound(qty * p, 100 * 100);
    case "PER_1000": return divideRound(qty * p, 100 * 1_000);
    case "LB":       return divideRound(Math.round(weight * 100) * p, 100 * 100);
    case "LOT":      return divideRound(p, 100);
  }
}

/** `base × rate` in cents, rounded half away from zero — surcharge percents and sales tax. */
function applyRate(baseCents: number, rate: number): number {
  return divideRound(baseCents * Math.round(rate * RATE_SCALE), RATE_SCALE);
}

/** Does this operation line fall inside the surcharge's scope? An operation with no step code at
 *  all (a line with no price rows) can never be *listed*, so `INCLUDE` never matches it and
 *  `EXCLUDE` always does. */
function inScope(surcharge: SurchargeInput, processStepCodeId: string | null): boolean {
  if (surcharge.scope === "ALL") return true;
  const listed = processStepCodeId !== null && surcharge.stepCodeIds.includes(processStepCodeId);
  return surcharge.scope === "INCLUDE" ? listed : !listed;
}

type LineFields = Omit<ComputedLine, "key" | "amount">;

function blank(kind: InvoiceLineKindValue): LineFields {
  return {
    kind, parentKey: null,
    orderLineId: null, processStepCodeId: null, surchargeId: null, orderChargeId: null,
    glAccountId: null, glAccountName: "",
    partNumber: "", partName: "", partDescription: "", description: "",
    qty: null, weight: null, eachWeight: null,
    pricePer: null, unitPrice: null, setupCharge: null, minimumCharge: null,
    breakThreshold: null, minimumApplied: false,
    rate: null, priceSource: null, sourceQuoteNumber: null, needsPrice: false,
  };
}

export function priceOrder(input: PricingInput): PricingResult {
  const lines: ComputedLine[] = [];
  // Cents alongside the lines: every base below (surcharge scope, tax) sums integer cents, so no
  // total is ever rebuilt out of dollars that have already been rounded.
  const cents: number[] = [];
  const operations: { processStepCodeId: string | null; cents: number }[] = [];

  /** `key` is `${kind}-${index}` — stable within one computation, and only ever used to wire
   *  `parentLineId` when the caller writes the rows. */
  function push(amountCents: number, fields: LineFields): ComputedLine {
    const line: ComputedLine = {
      ...fields, key: `${fields.kind}-${lines.length}`, amount: fromCents(amountCents),
    };
    lines.push(line);
    cents.push(amountCents);
    return line;
  }

  function totalFor(kind: InvoiceLineKindValue): number {
    return lines.reduce((sum, line, i) => (line.kind === kind ? sum + cents[i] : sum), 0);
  }

  for (const orderLine of input.lines) {
    const identity = {
      orderLineId: orderLine.orderLineId,
      partNumber: orderLine.partNumber, partName: orderLine.partName,
      partDescription: orderLine.partDescription,
    };
    // Quantities live on the PART line, once; its OPERATIONs hang off it and carry the money.
    const part = push(0, {
      ...blank("PART"), ...identity,
      qty: orderLine.shippedQty, weight: orderLine.shippedWeight, eachWeight: orderLine.eachWeight,
    });

    if (orderLine.prices.length === 0) {
      // Tier 3 of the §7.5 chain: zero, flagged, never silently priced and never silently dropped.
      push(0, {
        ...blank("OPERATION"), ...identity,
        parentKey: part.key, description: NEEDS_PRICE_LABEL, needsPrice: true,
      });
      operations.push({ processStepCodeId: null, cents: 0 });
      continue;
    }

    for (const row of orderLine.prices) {
      const chosen = selectBreak(row, orderLine.shippedQty, orderLine.shippedWeight);
      const price = chosen?.price ?? row.unitPrice;
      const extended = price === null
        ? 0
        : extendedCents(row.pricePer, orderLine.shippedQty, orderLine.shippedWeight, price);
      const minimum = toCents(row.minimumCharge ?? 0);
      const setup = toCents(row.setupCharge ?? 0);
      // Ruling 13: the minimum is a floor on the WORK; setup is added on top of it, never inside.
      const amount = Math.max(extended, minimum) + setup;
      push(amount, {
        ...blank("OPERATION"), ...identity,
        parentKey: part.key, processStepCodeId: row.processStepCodeId, description: row.stepName,
        glAccountId: row.glAccountId, glAccountName: row.glAccountName,
        pricePer: row.pricePer, unitPrice: price,
        setupCharge: row.setupCharge, minimumCharge: row.minimumCharge,
        breakThreshold: chosen?.threshold ?? null, minimumApplied: minimum > extended,
        // The Phase 6 pass-through (§4.2): what the row carries, not a hardcoded PART_PRICE — a
        // quote-built row lands QUOTE + its quote number; a part-price row defaults as before.
        priceSource: row.priceSource ?? "PART_PRICE",
        sourceQuoteNumber: row.sourceQuoteNumber ?? null,
        needsPrice: price === null && row.minimumCharge === null,
      });
      operations.push({ processStepCodeId: row.processStepCodeId, cents: amount });
    }
  }

  for (const surcharge of input.surcharges) {
    const qualifying = operations.filter((o) => inScope(surcharge, o.processStepCodeId));
    // No line at all when nothing qualifies — a minimum must not conjure a surcharge onto an
    // invoice the surcharge does not apply to.
    if (qualifying.length === 0) continue;
    const base = qualifying.reduce((sum, o) => sum + o.cents, 0);
    const computed = surcharge.kind === "PERCENT"
      ? applyRate(base, surcharge.rate ?? 0)
      : toCents(surcharge.amount ?? 0);
    push(Math.max(computed, toCents(surcharge.minimumAmount ?? 0)), {
      ...blank("SURCHARGE"),
      surchargeId: surcharge.surchargeId, description: surcharge.name,
      glAccountId: surcharge.glAccountId, glAccountName: surcharge.glAccountName,
      rate: surcharge.kind === "PERCENT" ? surcharge.rate : null,
    });
  }

  if (input.freight) {
    push(toCents(input.freight.amount), {
      ...blank("FREIGHT"), description: FREIGHT_LABEL,
      glAccountId: input.freight.glAccountId, glAccountName: input.freight.glAccountName,
    });
  }

  for (const charge of input.charges) {
    // The GL account an extra charge posts to is not part of this input (§4.5's
    // `otherChargeGlAccountId` lives on the billing config) — the caller owns that assignment.
    push(charge.amount === null ? 0 : toCents(charge.amount), {
      ...blank("CHARGE"),
      orderChargeId: charge.orderChargeId, description: charge.description,
      needsPrice: charge.amount === null,
    });
  }

  if (input.cert) {
    push(toCents(input.cert.amount), {
      ...blank("CERT"), description: input.cert.description,
      glAccountId: input.cert.glAccountId, glAccountName: input.cert.glAccountName,
    });
  }

  if (input.tax) {
    // Freight is excluded, and only freight (§5).
    const base = totalFor("OPERATION") + totalFor("SURCHARGE") + totalFor("CHARGE") + totalFor("CERT");
    push(applyRate(base, input.tax.rate), {
      ...blank("TAX"), description: TAX_LABEL, rate: input.tax.rate,
      glAccountId: input.tax.glAccountId, glAccountName: input.tax.glAccountName,
    });
  }

  const buckets = {
    subtotal: totalFor("OPERATION"),
    surchargeTotal: totalFor("SURCHARGE"),
    chargeTotal: totalFor("CHARGE"),
    certTotal: totalFor("CERT"),
    freightTotal: totalFor("FREIGHT"),
    taxTotal: totalFor("TAX"),
  };
  const total = Object.values(buckets).reduce((sum, b) => sum + b, 0);
  return {
    lines,
    subtotal: fromCents(buckets.subtotal),
    surchargeTotal: fromCents(buckets.surchargeTotal),
    chargeTotal: fromCents(buckets.chargeTotal),
    certTotal: fromCents(buckets.certTotal),
    freightTotal: fromCents(buckets.freightTotal),
    taxTotal: fromCents(buckets.taxTotal),
    total: fromCents(total),
  };
}
