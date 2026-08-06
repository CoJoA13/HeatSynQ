// Client-safe (no src/server imports): the ship-now prefill's arithmetic, so the shipment page's
// lines grid can compute it without reaching into `ship-ledger.ts` — the `load-split.ts` precedent
// for a pure derivation the server owns the INPUTS to and the client owns the DISPLAY of.
//
// Design §5.1 names the prefill exactly: "the ship-now prefill (`ordered − shipped`, editable)".
// It is a DEFAULT, never a cap — over-shipping warns and never blocks (§5.7), so nothing here (and
// nothing that calls it) may refuse a larger figure the operator types over it.

/**
 * `ordered − shippedToDate`, floored at zero and rounded to the two decimals the weight columns
 * actually store (`Decimal(12,2)`).
 *
 * Both halves matter for a real screen:
 * - **Floored at zero** because an already-over-shipped line would otherwise prefill a negative
 *   ship-now, which the server's own `z.number().int().min(0)` would reject outright — a default
 *   that cannot be saved is worse than a wrong one.
 * - **Rounded to 2dp** because binary floating point turns `25 − 12.1` into `12.899999999999999`,
 *   and that string is what an operator would find sitting in the input box. Quantities are
 *   integers, so the rounding is a no-op for them.
 *
 * `!(remainder > 0)` rather than `remainder <= 0` so a NaN input (a field mid-edit, a missing
 * ledger entry read as `undefined`) floors to 0 instead of propagating NaN into the box.
 */
export function shipRemainder(ordered: number, shippedToDate: number): number {
  const remainder = ordered - shippedToDate;
  if (!(remainder > 0)) return 0;
  return Math.round(remainder * 100) / 100;
}
