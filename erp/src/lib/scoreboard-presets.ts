// Client-safe (no src/server imports — the business-days.ts precedent): the two shortcut windows the
// Comparison scoreboard offers (Phase 8A Task 7, spec §4.3). The screen imports these to fill the
// date inputs on a preset click; the test imports the SAME functions to pin the windows, so the
// button and the assertion can never disagree. All math is UTC date-only (the `@db.Date` convention)
// so the host machine's local time zone never leaks into a week/month boundary.
import { dateOnly, formatDateOnly, addDays } from "./business-days";

/** The Monday–Sunday ISO week containing `today` (only `today`'s UTC calendar day matters). Monday
 *  is the first day, Sunday the last — a Sunday resolves to its OWN week, not the next one. Weekly is
 *  the parallel-run rhythm (§4.3). */
export function thisWeekWindow(today: Date): { from: string; to: string } {
  const day = dateOnly(today);
  const sinceMonday = (day.getUTCDay() + 6) % 7; // getUTCDay: 0=Sun..6=Sat → Mon=0..Sun=6
  const monday = addDays(day, -sinceMonday);
  return { from: formatDateOnly(monday), to: formatDateOnly(addDays(monday, 6)) };
}

/** The calendar month containing `today`: its first through its last day (day 0 of the next month is
 *  the last day of this one). The month is the acceptance milestone (§4.3). */
export function thisMonthWindow(today: Date): { from: string; to: string } {
  const day = dateOnly(today);
  const first = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  const last = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0));
  return { from: formatDateOnly(first), to: formatDateOnly(last) };
}
