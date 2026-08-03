// Client-safe (no src/server imports): splits an order's totals into loads under the lead
// part's qty/weight caps (spec §5.4). All weight math runs in integer cents-of-a-pound rather
// than floating pounds: computing each load's weight independently in pounds and letting the
// last one absorb `totalWeight - (already-assigned pounds)` can leave that last value a tick off
// pristine (e.g. 501.8000000000002 instead of 501.8) even though the true sum still cancels back
// to the total. Staying in integer cents until the single final division back to pounds keeps
// every value — including the rounding-absorbing last one — clean, and keeps the underlying cents
// exactly summing to the total by construction.

export type LoadSplit = { qty: number; weight: number };

/**
 * Splits `totalQty`/`totalWeight` into loads honoring both `loadQty` and `loadWeight` caps
 * together (spec §3.2/§5.4): each load carries as many pieces as fit under BOTH caps, using the
 * order's average each-weight (`totalWeight / totalQty`) to convert the weight cap into a
 * piece-count cap — `Math.max(1, …)` keeps a single piece heavier than the cap legal at one per
 * load rather than collapsing to zero. Neither cap set → the totals travel as a single load.
 *
 * Otherwise the pieces are chunked into `perLoadQty`-sized loads, the last chunk taking whatever
 * remainder is left (never a trailing zero-qty load when the total divides evenly). Each load's
 * weight is proportional to its share of the pieces, rounded to the cent; the last load absorbs
 * whatever that rounding leaves so the loads sum to the total exactly.
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

  const totalCents = Math.round(totalWeight * 100);
  const loads: LoadSplit[] = [];
  let remainingQty = totalQty;
  let usedCents = 0;
  while (remainingQty > 0) {
    const qty = Math.min(perLoadQty, remainingQty);
    remainingQty -= qty;
    const cents = remainingQty === 0 ? totalCents - usedCents : Math.round((totalCents * qty) / totalQty);
    usedCents += cents;
    loads.push({ qty, weight: cents / 100 });
  }
  return loads;
}
