// Pure, client-safe (no server/Prisma imports) — the results grid computes the exact same
// verdict the server does (src/server/cert-results.ts), so the screen never shows a value that
// disagrees with what gets stored. Spec §6.3.

/**
 * `null` when there is no value to judge at all. Otherwise `true` when the value falls within
 * whichever of `min`/`max` are actually set (inclusive — landing exactly on a bound passes),
 * `false` the moment it falls outside one that IS set. Neither bound set + a value present has
 * nothing to fail against, so it passes.
 */
export function computePassed(value: number | null, min: number | null, max: number | null): boolean | null {
  if (value === null) return null;
  if (min !== null && value < min) return false;
  if (max !== null && value > max) return false;
  return true;
}
