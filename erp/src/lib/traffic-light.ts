// Client-safe (no src/server imports): the order board's traffic light (spec §6). Pure so the
// board can render the same rule the service computed each row's light with, and so the entry
// page can preview it without a round trip.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most-urgent-first — this array's order IS `computeLight`'s evaluation order. */
export const TRAFFIC_LIGHTS = ["did_miss", "will_miss", "may_miss", "on_target"] as const;
export type TrafficLight = (typeof TRAFFIC_LIGHTS)[number];

/** Colour is never the only channel (spec §6): the board renders this text beside the dot, and
 *  the Excel export writes it in place of the raw key. */
export const LIGHT_LABELS: Record<TrafficLight, string> = {
  did_miss: "Did miss",
  will_miss: "Will miss",
  may_miss: "May miss",
  on_target: "On target",
};

/**
 * Classifies how close an order's request date is to today, most-urgent-first: `did_miss`
 * (strictly past — a request date arriving today has not been missed yet) → `will_miss` (within
 * `willMissDays`) → `may_miss` (within `mayMissDays`) → `on_target`. Both windows include their
 * own edge, and the ordering is structural rather than a consequence of the two settings' sizes,
 * so a date inside both windows always reports the urgent one — including if an owner ever
 * configures the will-miss window wider than the may-miss one.
 *
 * Both arguments are UTC-midnight `Date`s (`@db.Date` semantics — see business-days.ts). The
 * difference is taken in UTC so a local DST transition can never make a whole calendar day
 * measure 23 or 25 hours and round a date onto the wrong side of a boundary; `Math.round`
 * absorbs nothing in normal use and keeps the day count honest if a caller ever passes a `Date`
 * that carries a time component.
 */
export function computeLight(
  requestDate: Date, today: Date, mayMissDays: number, willMissDays: number,
): TrafficLight {
  const daysAway = Math.round((requestDate.getTime() - today.getTime()) / DAY_MS);
  if (daysAway < 0) return "did_miss";
  if (daysAway <= willMissDays) return "will_miss";
  if (daysAway <= mayMissDays) return "may_miss";
  return "on_target";
}
