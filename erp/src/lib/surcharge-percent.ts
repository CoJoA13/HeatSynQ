// Client-safe pure functions — no src/server imports. `Surcharge.rate` is stored as a decimal
// (Decimal(9,6): 4% is 0.040000) but the admin screen shows and accepts it as a percent (task-7
// brief) — "4 on screen stores 0.040000". Getting this backwards, or double-converting on a
// save/reload/save round trip, is the most likely real bug in that screen, so the conversion is
// pulled out here where it can be unit-tested directly instead of only exercised through the
// browser.
//
// String-based shift, not a bare `n / 100` / `n * 100`, for the display side too: `toFixed`
// after a floating-point multiply/divide is safe for the magnitudes this field actually sees
// (rate has at most 6 fractional digits, well inside a double's ~15-17 significant digits), but
// pinning the decimal place count explicitly is what keeps the exact "4 -> 0.040000" example in
// the brief true byte-for-byte rather than "true up to float noise."

/** Percent text as typed in the input (e.g. "4", "2.5", "") -> the decimal `rate` value to send
 *  on the wire (e.g. 0.04, 0.025, null). `null` for empty/unparseable input — the caller decides
 *  whether that's an error (decimalField on the server rejects `null` for a PERCENT surcharge
 *  with its own field-anchored message; this function doesn't need to duplicate that check). */
export function percentToDecimal(percentText: string): number | null {
  const trimmed = percentText.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  // Fixed to 6 places — `rate`'s own scale — so the result never carries more fractional digits
  // than the column allows, regardless of how many the user typed.
  return Number((n / 100).toFixed(6));
}

/** The decimal `rate` value as loaded from the server (e.g. 0.04) -> the percent text to show in
 *  the input (e.g. "4"). `""` for `null` (no rate set). */
export function decimalToPercentText(rate: number | null): string {
  if (rate === null) return "";
  // Fixed to 4 places (rate's 6 fractional digits, shifted 2 by the *100), then re-numbered to
  // drop trailing zeros for display ("4.0000" -> 4 -> "4").
  return String(Number((rate * 100).toFixed(4)));
}
