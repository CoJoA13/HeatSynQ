// Not a route — the `reports/backlog/query.ts` single-parse discipline: GET /api/reports/sales and
// its export route must agree on exactly what a query string means, so the parse lives here once and
// both routes import it.
import type { SalesFilter, SalesGroupBy } from "@/server/reports/sales";

/** An absent param and a blank one both mean "not set" — the `orders/query.ts` `orUndefined`
 *  precedent, duplicated rather than imported (not worth the cross-tree coupling for four lines). */
function orUndefined(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

/** Turns the sales screen's query string into the `SalesFilter` shape `reportSales` expects. Dates
 *  and `groupBy` pass through unvalidated on purpose — `reportSales` already turns a malformed date
 *  into a field-anchored 400 (`parseDate`) and an unknown group into its own 400 (`normalizeGroupBy`),
 *  so re-checking here would just duplicate a rule the service owns. There is no `partId` filter: a
 *  Sales report reads the FROZEN part-number snapshot and cannot honour a live-part filter without a
 *  live join the frozen-paper rule forbids — part is a groupBy dimension only. */
export function parseSalesFilter(url: URL): SalesFilter {
  return {
    customerId: orUndefined(url.searchParams.get("customerId")),
    from: orUndefined(url.searchParams.get("from")),
    to: orUndefined(url.searchParams.get("to")),
    groupBy: orUndefined(url.searchParams.get("groupBy")) as SalesGroupBy | undefined,
  };
}
