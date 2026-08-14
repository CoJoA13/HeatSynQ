// Not a route — the `reports/backlog/query.ts` single-parse discipline: GET /api/reports/shipped
// and its export route must agree on exactly what a query string means, so the parse lives here
// once and both routes import it.
import type { ShippedFilter, ShippedGroupBy } from "@/server/reports/shipped";

/** An absent param and a blank one both mean "not set" — the `orders/query.ts` `orUndefined`
 *  precedent, duplicated rather than imported (not worth the cross-tree coupling for four lines). */
function orUndefined(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

/** Turns the shipped screen's query string into the `ShippedFilter` shape `reportShipped` expects.
 *  Dates and `groupBy` pass through unvalidated on purpose — `reportShipped` already turns a
 *  malformed date into a field-anchored 400 (`parseDate`) and an unknown group into its own 400
 *  (`normalizeGroupBy`), so re-checking here would just duplicate a rule the service owns. */
export function parseShippedFilter(url: URL): ShippedFilter {
  return {
    customerId: orUndefined(url.searchParams.get("customerId")),
    partId: orUndefined(url.searchParams.get("partId")),
    from: orUndefined(url.searchParams.get("from")),
    to: orUndefined(url.searchParams.get("to")),
    groupBy: orUndefined(url.searchParams.get("groupBy")) as ShippedGroupBy | undefined,
  };
}
