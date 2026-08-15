// Not a route — the `reports/sales/query.ts` single-parse discipline: GET /api/reports/scoreboard and
// its export route must agree on exactly what a query string means, so the parse lives here once and
// both routes import it. The scoreboard's ONE {from,to} window drives the page AND the export.
import type { ScoreboardFilter } from "@/server/reports/scoreboard";

/** An absent param and a blank one both mean "not set" — the `orders/query.ts` `orUndefined`
 *  precedent, duplicated rather than imported (not worth the cross-tree coupling for four lines). */
function orUndefined(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

/** Turns the scoreboard screen's query string into the `ScoreboardFilter` shape. Dates pass through
 *  unvalidated on purpose — `reportScoreboard` already turns a malformed bound into a field-anchored
 *  400 (`parseDate`), so re-checking here would just duplicate a rule the service owns. */
export function parseScoreboardFilter(url: URL): ScoreboardFilter {
  return {
    from: orUndefined(url.searchParams.get("from")),
    to: orUndefined(url.searchParams.get("to")),
  };
}
