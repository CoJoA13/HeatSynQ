// Not a route — the invoices/query.ts precedent: GET /api/receivables/aging and its export route
// (aging/export/route.ts) must agree on exactly what a given query string means, so the parse
// lives here once.
import type { AgingFilter } from "@/server/aging";

/** An absent param and a blank one both mean "not set" — the orders/query.ts `orUndefined`
 *  precedent, duplicated rather than imported (the shippers/query.ts precedent: not worth the
 *  cross-tree coupling for a four-line helper). */
function orUndefined(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

/** Turns the aging screen's query string into the `AgingFilter` shape `agingReport` expects.
 *  `asOf` passes through unvalidated on purpose — `agingReport` already turns a malformed date
 *  into its own field-anchored 400 via `parseAsOf`, so re-checking here would just be a second
 *  copy of a rule the service already owns. */
export function parseAgingFilter(url: URL): AgingFilter {
  return {
    customerId: orUndefined(url.searchParams.get("customerId")),
    asOf: orUndefined(url.searchParams.get("asOf")),
  };
}
