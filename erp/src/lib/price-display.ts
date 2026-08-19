// Client-safe leaf (no src/server imports). #14 item 4 — ONE display convention for the
// 4-decimal price inputs: the text a fresh reload would render.

/**
 * The server stores prices as Decimal(12,4) but serializes them to JS numbers, and React renders
 * a number via its shortest round-trip string — so a blur-save of "0.5500" reads "0.55" on every
 * later reload while the session that typed it kept showing "0.5500" (the optimistic set keeps
 * the typed text). Re-setting the input to this normalized form on a SUCCESSFUL blur-save makes
 * the session agree with the reload — and with the audit diff, which renders the same serialized
 * number.
 *
 * Unparseable or blank input comes back unchanged — defensive only: a successful save implies
 * the server accepted the text as a decimal, and the callers skip blank-to-null saves entirely.
 */
export function normalizePriceText(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return value;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return value;
  return String(n);
}
