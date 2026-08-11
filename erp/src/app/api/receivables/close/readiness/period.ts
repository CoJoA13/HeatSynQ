import { HttpError } from "@/server/errors";

/** Parse `?year=&month=` into the month-end Date both readiness routes scope on. `Date.UTC(year,
 *  month, 0)` is day 0 of the next month = this month's last day (month is 1-based here), matching
 *  the period end `exportClose` derives from `ClosePeriod.year`/`month`. 400 on a missing/invalid
 *  pair, so the panel and its export can never read a different period than the close does.
 *
 *  An ABSENT year needs its own guard: `Number(null)` and `Number("")` are both `0`, which passes
 *  `Number.isInteger` and yields `Date.UTC(0, month, 0)` = year 1900 (JS maps 0-99 to 1900-1999) —
 *  a silently wrong period. Range-bound the year (>= 2000) so a missing/blank year is a 400, not 1900. */
export function parseReadinessPeriod(url: URL): Date {
  const year = Number(url.searchParams.get("year"));
  const month = Number(url.searchParams.get("month"));
  if (!Number.isInteger(year) || year < 2000 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new HttpError(400, "year (>= 2000) and month (1-12) are required");
  }
  return new Date(Date.UTC(year, month, 0));
}
