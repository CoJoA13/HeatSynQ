// Not a route — Next only maps a file literally named `route.ts`, so this plain module can sit
// alongside `route.ts`/`export/route.ts` and be imported by both without being mistaken for a
// third handler.
//
// orders.ts's own doc comment on `OrderFilter` puts this in writing: "status is already typed,
// so the route that turns a query string into this shape owns that parse." Extracted into one
// function — rather than duplicated inline the way parts/customers' trivial two-field filters are
// (parts/route.ts, parts/export/route.ts) — because GET /api/orders and GET /api/orders/export
// must agree on exactly what a given query string means; two hand-written copies of status/date
// parsing are two chances to drift apart on that.
import { HttpError } from "@/server/http";
import type { OrderFilter } from "@/server/orders";
import { OrderStatus } from "../../../../prisma/generated/prisma/client";

const STATUS_VALUES = new Set<string>(Object.values(OrderStatus));

/**
 * An absent query param and a blank one ("...&receivedFrom=&...", what an empty date/text input
 * serializes to) must both mean "not set" — never forwarded into `parseDate` as a literal empty
 * string, which the service would otherwise reject as a malformed date rather than treat as no
 * filter at all (Task 9 review note, task-9-brief.md's date-params callout). Exported so
 * `entry-defaults/route.ts` — the one other route with this exact "blank means absent" rule for a
 * query param — reuses it rather than keeping its own copy in sync by hand.
 */
export function orUndefined(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

/**
 * Accepts EITHER wire convention for a multi-value filter — repeated params
 * (`status=OPEN&status=SHIPPED`) or one comma-joined param (`status=OPEN,SHIPPED`), or a mix of
 * both — since nothing else in this codebase fixes a house style for an array-shaped query filter
 * yet. Rejects an unrecognized token as a field-anchored 400 naming it: `listOrders`/`exportOrders`
 * hand `status` straight to Prisma's `{ in: [...] }`, and an enum value Prisma has never heard of
 * throws a status-less `PrismaClientValidationError` there — a bare 500 rather than the clean 400
 * every other bad filter in this app produces. Absent entirely (no token survives) returns
 * `undefined` so the filter key is omitted rather than sent as `[]` (which would match nothing).
 */
function parseStatus(url: URL): OrderFilter["status"] {
  const tokens = url.searchParams.getAll("status")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (tokens.length === 0) return undefined;
  for (const token of tokens) {
    if (!STATUS_VALUES.has(token)) throw new HttpError(400, `Unknown order status "${token}"`);
  }
  return tokens as OrderFilter["status"];
}

/** Turns the board's query string into the `OrderFilter` shape `listOrders`/`exportOrders`
 *  expect. `sort`/`dir` pass through unvalidated on purpose — `listOrders` already rejects an
 *  unknown `sort` key with its own field-anchored 400, and any `dir` other than exactly `"asc"`
 *  already falls back to `"desc"` there, so re-checking either here would just be a second copy
 *  of a rule the service already owns. */
export function parseOrderFilter(url: URL): OrderFilter {
  const dir = orUndefined(url.searchParams.get("dir"));
  return {
    search: orUndefined(url.searchParams.get("search")),
    status: parseStatus(url),
    customerId: orUndefined(url.searchParams.get("customerId")),
    receivedFrom: orUndefined(url.searchParams.get("receivedFrom")),
    receivedTo: orUndefined(url.searchParams.get("receivedTo")),
    requestFrom: orUndefined(url.searchParams.get("requestFrom")),
    requestTo: orUndefined(url.searchParams.get("requestTo")),
    includeVoided: url.searchParams.get("includeVoided") === "1",
    sort: orUndefined(url.searchParams.get("sort")),
    dir: dir as OrderFilter["dir"],
  };
}
