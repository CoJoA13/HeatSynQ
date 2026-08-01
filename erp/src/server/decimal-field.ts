import { z } from "zod";

// Accepts a plain number or a decimal string ("25000.00"), but never an arbitrary string: an
// invalid one (e.g. "not-a-number") used to sail through zod as a string and blow up inside
// Prisma with a PrismaClientValidationError, which has no HTTP status and escapes handle() as a
// bare 500 instead of the field-anchored 400 Spec §12 promises.
//
// `precision`/`scale` must match the column's own `@db.Decimal(precision, scale)` exactly — see
// the paired comment on Customer.creditLimit/financeChargeRate in prisma/schema.prisma, which
// points back here. A shared, column-agnostic validator (the previous shape of this function)
// only checked that a value WAS a decimal, never that it FIT the specific column it was headed
// for: "100" is a fine decimal but overflows financeChargeRate's Decimal(6,4) (max 99.9999) and
// blows up inside Prisma with a status-less error (still a 500); "1.005" is a fine decimal but
// has one more fractional digit than creditLimit's Decimal(12,2) allows, so Postgres silently
// rounds it to 1.01 on write. Both are field-anchored 400s here instead: the regex bounds the
// integer-digit count to `precision - scale` and the fractional-digit count to `scale` directly,
// so a value that passes can neither overflow the column nor lose precision to rounding.
// Overloads, not a single signature: the implementation's own inferred return type is a flat
// union (number | null | undefined) because the `shaped = opts?.required ? base : ...` ternary
// is evaluated at runtime, not at the type level, so TS can't narrow it per call site from the
// body alone. At runtime `required: true` genuinely can never produce null/undefined (`shaped`
// is `base` with no `.nullable().optional()`, so the transform's null/undefined branch is
// unreachable) — these overloads just let the caller's type reflect that existing guarantee.
export function decimalField(
  precision: number, scale: number,
  opts: { required: true; min?: "positive" | "nonnegative" },
): z.ZodType<number, number | string>;
export function decimalField(
  precision: number, scale: number,
  opts?: { required?: false; min?: "positive" | "nonnegative" },
): z.ZodType<number | null | undefined, number | string | null | undefined>;
export function decimalField(
  precision: number, scale: number,
  opts?: { required?: boolean; min?: "positive" | "nonnegative" },
): z.ZodType<number | null | undefined, number | string | null | undefined> {
  const intDigits = precision - scale;
  const pattern = new RegExp(`^-?\\d{1,${intDigits}}(\\.\\d{1,${scale}})?$`);
  const message =
    `Must be a decimal with at most ${intDigits} digit${intDigits === 1 ? "" : "s"} before ` +
    `and ${scale} digit${scale === 1 ? "" : "s"} after the decimal point`;
  const base = z.union([z.number(), z.string()]);
  const shaped = opts?.required ? base : base.nullable().optional();
  return shaped.transform((value, ctx) => {
    if (value === null || value === undefined) return value as null | undefined;
    // A non-finite number (NaN/Infinity) stringifies to something the digit pattern below can
    // never match ("NaN", "Infinity"), so it is rejected by the same check as any other
    // malformed value rather than needing a separate Number.isFinite guard.
    const raw = typeof value === "number" ? String(value) : value.trim();
    if (!pattern.test(raw)) { ctx.addIssue({ code: z.ZodIssueCode.custom, message }); return z.NEVER; }
    const n = Number(raw);
    if (opts?.min === "positive" && n <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be greater than zero" }); return z.NEVER;
    }
    if (opts?.min === "nonnegative" && n < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must not be negative" }); return z.NEVER;
    }
    return n;
  });
}
