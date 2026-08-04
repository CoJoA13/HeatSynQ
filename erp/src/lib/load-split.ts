// Client-safe (no src/server imports): splits an order's totals into loads under the lead
// part's qty/weight caps (spec §5.4). All weight math runs in integer cents-of-a-pound rather
// than floating pounds: computing each load's weight independently in pounds and letting the
// last one absorb `totalWeight - (already-assigned pounds)` can leave that last value a tick off
// pristine (e.g. 501.8000000000002 instead of 501.8) even though the true sum still cancels back
// to the total. Staying in integer cents until the single final division back to pounds keeps
// every value — including the rounding-absorbing last one — clean, and keeps the underlying cents
// exactly summing to the total by construction.

export type LoadSplit = { qty: number; weight: number };

/** Fix-wave R2 finding 3: nothing else bounds how many loads a split can produce — a huge
 *  `totalQty` under a tiny `loadQty`/`loadWeight` cap would otherwise allocate one object per
 *  load synchronously, unbounded (the finding's own repro: 10,000,000 pcs at 1/load). Checked
 *  analytically against the load COUNT before any allocation happens, not by letting the loop
 *  run and counting — the whole point is refusing before the memory is ever touched. */
export const MAX_LOADS = 10_000;

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
    return [{ qty: totalQty, weight: totalWeight }];
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
    const cumCents = remainingQty === 0 ? totalCents : Math.round((totalCents * cumQty) / totalQty);
    loads.push({ qty, weight: (cumCents - priorCumCents) / 100 });
    priorCumCents = cumCents;
  }
  return loads;
}
