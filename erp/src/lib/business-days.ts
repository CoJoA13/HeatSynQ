// Client-safe (no src/server imports): "yyyy-mm-dd" date-only parsing/formatting and Mon–Fri
// business-day math over UTC-midnight `Date` objects, matching `@db.Date` column semantics.
// Everything here stays in UTC getters/arithmetic on purpose — the host machine's local time
// zone (not necessarily UTC) must never leak into a day boundary, which local-time methods like
// `setDate` would risk around DST transitions.

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parses a "yyyy-mm-dd" string into a UTC-midnight `Date`. Throws a plain `Error` — never
 * `HttpError`; this module has no server import — when the string isn't that shape or doesn't
 * name a real calendar date.
 *
 * Mirrors `part-process-steps.ts`'s `validateStepValue` DATE guard: `Date.UTC` silently rolls a
 * nonexistent calendar date (2025-02-29) forward into the next valid one (March 1) instead of
 * rejecting it, so the y/m/d are read back out of the constructed date and compared against what
 * was asked for — any mismatch means the input didn't round-trip and is rejected.
 */
export function parseDateOnly(s: string): Date {
  const match = DATE_ONLY.exec(s.trim());
  if (!match) {
    throw new Error(`"${s}" is not a valid date (yyyy-mm-dd)`);
  }
  const [, yStr, mStr, dStr] = match;
  const y = Number(yStr), m = Number(mStr), d = Number(dStr);
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  const rolled = asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== m - 1 || asUtc.getUTCDate() !== d;
  if (Number.isNaN(asUtc.getTime()) || rolled) {
    throw new Error(`"${s}" is not a valid date (yyyy-mm-dd)`);
  }
  return asUtc;
}

/** Formats a UTC-midnight `Date` back to "yyyy-mm-dd" — the inverse of `parseDateOnly`. */
export function formatDateOnly(d: Date): string {
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today at UTC midnight — the same "no time-of-day" reading a `@db.Date` column round-trips. */
export function todayDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ~10 calendar years — far beyond any legitimate request-date lead time (spec §7.1's chain tops
// out at a plant default measured in single-digit days). The day-at-a-time loop below is O(n);
// nothing upstream capped `n` before this fix, so a bad requestDaysOverride/request_days_default
// (or historical data predating the zod caps added alongside this) could stall the event loop
// rather than fail cleanly.
const MAX_OFFSET_DAYS = 3650;

/**
 * Advances `start` by `n` business days (Mon–Fri; no holiday calendar — spec §3.4/§6). Each of
 * the `n` steps moves one calendar day and only counts it toward `n` if it lands on a weekday,
 * so e.g. `addBusinessDays(<a Thursday>, 5)` lands on the same weekday the following week.
 * `n = 0` returns `start` unchanged, whatever day it falls on.
 */
export function addBusinessDays(start: Date, n: number): Date {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`addBusinessDays: n must be a non-negative integer, got ${n}`);
  }
  if (n > MAX_OFFSET_DAYS) {
    throw new Error(`Request-day offsets are capped at ${MAX_OFFSET_DAYS}`);
  }
  let result = start.getTime();
  let remaining = n;
  while (remaining > 0) {
    result += DAY_MS;
    const day = new Date(result).getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) remaining--;
  }
  return new Date(result);
}

/**
 * Advances `start` by `n` plain calendar days — no weekend/business-day skipping (unlike
 * `addBusinessDays` above). A due date is a calendar date (Phase 5B §4.3: `dueDate = invoiceDate +
 * terms.netDays`), so this is deliberately the simpler arithmetic: every `DAY_MS` multiple of a
 * UTC-midnight `Date` is itself UTC-midnight, so the result stays on the `parseDateOnly`/
 * `formatDateOnly` convention with no re-normalization needed. `n` may be negative (a back-dated
 * offset) — only integrality is enforced, matching a plain calendar-day add rather than
 * `addBusinessDays`' non-negative, capped request-day-offset contract.
 */
export function addDays(start: Date, n: number): Date {
  if (!Number.isInteger(n)) {
    throw new Error(`addDays: n must be an integer, got ${n}`);
  }
  return new Date(start.getTime() + n * DAY_MS);
}
