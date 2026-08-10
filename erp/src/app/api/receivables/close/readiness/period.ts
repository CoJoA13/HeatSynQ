import { HttpError } from "@/server/errors";

/** Parse `?year=&month=` into the month-end Date both readiness routes scope on. `Date.UTC(year,
 *  month, 0)` is day 0 of the next month = this month's last day (month is 1-based here), matching
 *  the period end `exportClose` derives from `ClosePeriod.year`/`month`. 400 on a missing/invalid
 *  pair, so the panel and its export can never read a different period than the close does. */
export function parseReadinessPeriod(url: URL): Date {
  const year = Number(url.searchParams.get("year"));
  const month = Number(url.searchParams.get("month"));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new HttpError(400, "year and month (1-12) are required");
  }
  return new Date(Date.UTC(year, month, 0));
}
