// Not a route — the `reports/sales/query.ts` single-parse discipline: GET /api/reports/payments and
// its export route must agree on exactly what a query string means, so the parse lives here once and
// both routes import it.
import type { PaymentsFilter, PaymentsGroupBy } from "@/server/reports/payments";

/** An absent param and a blank one both mean "not set" — the `sales/query.ts` `orUndefined`
 *  precedent, duplicated rather than imported (not worth the cross-tree coupling for four lines). */
function orUndefined(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

/** Turns the payments screen's query string into the `PaymentsFilter` shape `reportPayments`
 *  expects. Dates and `groupBy` pass through unvalidated on purpose — `reportPayments` already turns
 *  a malformed date into a field-anchored 400 (`parseDate`) and an unknown group into its own 400
 *  (`normalizeGroupBy`), so re-checking here would just duplicate a rule the service owns. There is
 *  no `partId` filter: a payment pays invoices, not parts. */
export function parsePaymentsFilter(url: URL): PaymentsFilter {
  return {
    customerId: orUndefined(url.searchParams.get("customerId")),
    from: orUndefined(url.searchParams.get("from")),
    to: orUndefined(url.searchParams.get("to")),
    groupBy: orUndefined(url.searchParams.get("groupBy")) as PaymentsGroupBy | undefined,
  };
}
