// Client-safe (no src/server imports): splits an order's totals into loads under the lead
// part's qty/weight caps (spec §5.4). All weight math runs in integer cents-of-a-pound rather
// than floating pounds: computing each load's weight independently in pounds and letting the
// last one absorb `totalWeight - (already-assigned pounds)` can leave that last value a tick off
// pristine (e.g. 501.8000000000002 instead of 501.8) even though the true sum still cancels back
// to the total. Staying in integer cents until the single final division back to pounds keeps
// every value — including the rounding-absorbing last one — clean, and keeps the underlying cents
// exactly summing to the total by construction.

import { INT4_MAX, LOAD_WEIGHT_MAX } from "./order-constants";

export type LoadSplit = { qty: number; weight: number };

/** Fix-wave R2 finding 3: nothing else bounds how many loads a split can produce — a huge
 *  `totalQty` under a tiny `loadQty`/`loadWeight` cap would otherwise allocate one object per
 *  load synchronously, unbounded (the finding's own repro: 10,000,000 pcs at 1/load). Checked
 *  analytically against the load COUNT before any allocation happens, not by letting the loop
 *  run and counting — the whole point is refusing before the memory is ever touched. */
export const MAX_LOADS = 10_000;


const fmtQty = (n: number) => n.toLocaleString("en-US");
const fmtWeight = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** `round(totalCents * cumQty / totalQty)` computed EXACTLY (Codex PR #141 round 3): the float
 *  product overflows 2^53 at large-but-legal scale — 2,329 ceiling-weight loads put it near 4e25 —
 *  and the lost precision shifted a cent between adjacent loads, pushing one a cent past
 *  DECIMAL(12,2) and turning a storable split into a refusal. BigInt keeps the product exact;
 *  `+ den/2` before the truncating division is round-half-up, exactly `Math.round`'s behaviour for
 *  the positive values this function ever sees, so every in-range split is bit-identical to the
 *  old arithmetic. The RESULT always fits a double again (`cumCents ≤ totalCents < 2^53`). */
function roundedShareCents(totalCents: number, cumQty: number, totalQty: number): number {
  // `BigInt(2)`, not a `2n` literal — tsconfig targets ES2017, which refuses BigInt literal
  // syntax while the BigInt global itself is available (Next transpiles for the browsers; Node
  // runs it natively either way).
  const den = BigInt(totalQty);
  return Number((BigInt(totalCents) * BigInt(cumQty) + den / BigInt(2)) / den);
}

/**
 * #42: every load this module RETURNS must fit its destination columns — `Load.qty` is a
 * Postgres INTEGER and `Load.weight` a DECIMAL(12,2). Independently valid lines can sum past
 * either (215 lines of 10,000,000 pcs make one 2,150,000,000-pc load; two near-max line weights
 * make one unstorable weight), and an unchecked load then failed at insert as an unmapped
 * Postgres overflow — a 500, not a refusal. Checked on the OUTPUT loads rather than the input
 * totals because the split itself can resolve an overflow (a capped split chunks an overflowing
 * total into loads that each fit) or fail to (a large-enough cap still emits an unstorable
 * load). Plain `Error`s, the MAX_LOADS shape — `runSplitLoads` (orders.ts) translates them into
 * the field-anchored 400 for both generated-load callers (createOrder and resplitLoads).
 */
function assertLoadsFitColumns(loads: LoadSplit[]): LoadSplit[] {
  for (const [i, load] of loads.entries()) {
    if (load.qty > INT4_MAX) {
      throw new Error(
        `Load ${i + 1}'s quantity ${fmtQty(load.qty)} exceeds the database maximum ` +
        `${fmtQty(INT4_MAX)} — check the line quantities`,
      );
    }
    if (load.weight > LOAD_WEIGHT_MAX) {
      throw new Error(
        `Load ${i + 1}'s weight ${fmtWeight(load.weight)} exceeds the database maximum ` +
        `${fmtWeight(LOAD_WEIGHT_MAX)} — check the line weights`,
      );
    }
  }
  return loads;
}

/**
 * Splits `totalQty`/`totalWeight` into loads honoring both `loadQty` and `loadWeight` caps
 * together (spec §3.2/§5.4): each load carries as many pieces as fit under BOTH caps, using the
 * order's average each-weight (`totalWeight / totalQty`) to convert the weight cap into a
 * piece-count cap — `Math.max(1, …)` keeps a single piece heavier than the cap legal at one per
 * load rather than collapsing to zero. Neither cap set → the totals travel as a single load.
 *
 * Otherwise the pieces are chunked into `perLoadQty`-sized loads, the last chunk taking whatever
 * remainder is left (never a trailing zero-qty load when the total divides evenly). Throws a
 * plain `Error` (no server import in this file — HttpError lives in src/server) naming the count
 * and the cap when that would take more than `MAX_LOADS` loads; callers translate it into a
 * field-anchored 400 (orders.ts's `runSplitLoads`).
 *
 * Each load's weight is proportional to its share of the pieces, rounded to the cent —
 * CUMULATIVELY, not independently per load (fix-wave R2 finding 2): rounding each non-final
 * load's own share separately can round several loads up in the same direction and consume more
 * cents than the total actually holds, leaving the last load — which just absorbs whatever
 * rounding left over — to go negative to balance the books (e.g. totalQty=5, totalWeight=0.03,
 * capped at 1/load: four loads independently round 0.6 cents up to 1, spending 4 of the 3 cents
 * there, and the fifth load absorbs 3-4 = -1 cent). Instead, each load's weight is the CUMULATIVE
 * rounded total through that load minus the cumulative rounded total through the previous one —
 * the standard largest-remainder/apportionment technique — which guarantees the running sum is
 * always within half a cent of the ideal running share, so no individual load's cents can ever go
 * negative or exceed its own proportional share by more than a cent, and the loads still sum to
 * the total exactly by construction (a telescoping sum of consecutive differences).
 */
export function splitLoads(input: {
  totalQty: number;
  totalWeight: number;
  loadQty: number | null;
  loadWeight: number | null;
}): LoadSplit[] {
  const { totalQty, totalWeight, loadQty, loadWeight } = input;

  if (loadQty === null && loadWeight === null) {
    return assertLoadsFitColumns([{ qty: totalQty, weight: totalWeight }]);
  }

  const eachWeight = totalWeight / totalQty;
  const perLoadQty = Math.min(
    loadQty ?? Infinity,
    loadWeight ? Math.max(1, Math.floor(loadWeight / eachWeight)) : Infinity,
  );

  const loadCount = Math.ceil(totalQty / perLoadQty);
  if (loadCount > MAX_LOADS) {
    throw new Error(
      `This split would produce ${loadCount} loads (max ${MAX_LOADS.toLocaleString("en-US")}) — ` +
      "check the part's load quantity",
    );
  }

  const totalCents = Math.round(totalWeight * 100);
  const loads: LoadSplit[] = [];
  let remainingQty = totalQty;
  let cumQty = 0;
  let priorCumCents = 0;
  while (remainingQty > 0) {
    const qty = Math.min(perLoadQty, remainingQty);
    remainingQty -= qty;
    cumQty += qty;
    const cumCents = remainingQty === 0 ? totalCents : roundedShareCents(totalCents, cumQty, totalQty);
    loads.push({ qty, weight: (cumCents - priorCumCents) / 100 });
    priorCumCents = cumCents;
  }
  return assertLoadsFitColumns(loads);
}
