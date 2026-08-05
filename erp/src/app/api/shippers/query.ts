// Not a route — the orders/query.ts precedent: GET /api/shippers and GET /api/shippers/export
// must agree on exactly what a given query string means, so the parse lives here once rather
// than as two hand-written copies that could drift.
import type { ShipperFilter } from "@/server/shippers";

/** An absent param and a blank one ("...&customerId=&...") both mean "not set" — the
 *  orders/query.ts `orUndefined` precedent, duplicated rather than imported: importing across
 *  route trees for one four-line helper is not worth the coupling. */
function orUndefined(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

/** Turns the shipping board's query string into the `ShipperFilter` shape `listShippers`/
 *  `exportShippers` expect. `from`/`to` pass through unvalidated on purpose — `shipperListWhere`
 *  (shippers.ts) already turns a malformed date into its own field-anchored 400 via `parseDate`,
 *  so re-checking here would just be a second copy of a rule the service already owns. */
export function parseShipperFilter(url: URL): ShipperFilter {
  return {
    customerId: orUndefined(url.searchParams.get("customerId")),
    from: orUndefined(url.searchParams.get("from")),
    to: orUndefined(url.searchParams.get("to")),
    includeVoided: url.searchParams.get("includeVoided") === "1",
    search: orUndefined(url.searchParams.get("search")),
  };
}
