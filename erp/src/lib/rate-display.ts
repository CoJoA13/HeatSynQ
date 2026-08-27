// Client-safe leaf (no src/server imports). #227 — ONE display convention for rate fields: every
// rate the UI shows or accepts is a PERCENT (7 means 7%), whatever the storage convention is.
//
// Storage stays split by design: `BillingConfig.salesTaxRate` / `Customer.salesTaxRate` and the
// frozen `Invoice.taxRate` snapshot are FRACTIONS (0.07 = 7% — pricing.ts multiplies directly),
// while `financeChargeRate` on both models is already a percent number (1.5 = 1.5%/month —
// finance-charges.ts divides by 100). So only the fraction fields convert, and they convert HERE,
// at the edit/display seam — the wire and the database never change convention.
//
// The shift is an exact decimal-STRING operation, never float arithmetic: 0.07 × 100 is
// 7.000000000000001 in floats, and a rate field that renders that teaches the operator to
// distrust every figure on the page. Text the pattern cannot parse comes back unchanged — the
// server's decimalField stays the only validator, and its 400 lands exactly as it does today.

/** Shift a plain decimal string's point by `k` places (positive = ×10^k). Non-decimals untouched. */
function shiftDecimal(text: string, k: number): string {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return text; // "", "-", ".", or not a decimal
  const sign = m[1];
  let digits = m[2] + (m[3] ?? "");
  let point = m[2].length + k; // the point's new index within `digits`
  if (point <= 0) { digits = "0".repeat(1 - point) + digits; point = 1; }
  if (point > digits.length) digits = digits + "0".repeat(point - digits.length);
  const int = digits.slice(0, point).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(point).replace(/0+$/, "");
  return sign + int + (frac === "" ? "" : `.${frac}`);
}

/** Stored fraction → displayed percent text: 0.07 → "7", 0.0625 → "6.25", null/blank → "". The
 *  server serializes Decimal(9,6) to a number; `String()` of any such value is a plain decimal
 *  (the smallest nonzero, 0.000001, still stringifies un-exponentiated). */
export function percentFromFraction(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return shiftDecimal(typeof value === "number" ? String(value) : value.trim(), 2);
}

/** Typed percent text → the fraction string the wire carries: "7" → "0.07", "1.5" → "0.015".
 *  Blank stays blank (the pages map "" to null themselves); unparseable text passes through for
 *  the server to refuse. */
export function fractionFromPercent(text: string): string {
  return shiftDecimal(text.trim(), -2);
}
