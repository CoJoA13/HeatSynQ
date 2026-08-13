// Not a route — Next only maps files literally named `route.ts` (the orders/query.ts precedent,
// and for the same reason it exists there): GET /api/quotes and GET /api/quotes/export must
// agree on exactly what a given query string means, so the parse lives once, imported by both.
import { HttpError } from "@/server/http";
import type { QuoteFilter } from "@/server/quotes";
import { QUOTE_STATUSES, type QuoteStatusValue } from "@/lib/quote-constants";
import { orUndefined } from "../orders/query";

const STATUS_VALUES = new Set<string>(QUOTE_STATUSES);

/** A single stored-status token (OPEN/CLOSED). The derived "Expired" display state is not a
 *  status — the UI reaches it through the `expired` flag below (ruling 3). An unknown token is
 *  a field-anchored 400, never handed to Prisma to explode as a status-less 500. */
function parseStatus(url: URL): QuoteStatusValue | undefined {
  const raw = orUndefined(url.searchParams.get("status"));
  if (raw === undefined) return undefined;
  if (!STATUS_VALUES.has(raw)) throw new HttpError(400, `Unknown quote status "${raw}"`);
  return raw as QuoteStatusValue;
}

/** Tri-state boolean filter: "1" narrows to the predicate, "0" to its complement, absent (or
 *  blank — what an empty select serializes to) leaves the axis unfiltered. Anything else is a
 *  400 naming the parameter rather than a silently ignored token. */
function parseFlag(url: URL, name: string): boolean | undefined {
  const raw = orUndefined(url.searchParams.get(name));
  if (raw === undefined) return undefined;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new HttpError(400, `${name} must be 1 or 0`);
}

export function parseQuoteFilter(url: URL): QuoteFilter {
  return {
    search: orUndefined(url.searchParams.get("search")),
    status: parseStatus(url),
    expired: parseFlag(url, "expired"),
    followUpDue: parseFlag(url, "followUpDue"),
    customerId: orUndefined(url.searchParams.get("customerId")),
    quoteFrom: orUndefined(url.searchParams.get("quoteFrom")),
    quoteTo: orUndefined(url.searchParams.get("quoteTo")),
    effectiveFrom: orUndefined(url.searchParams.get("effectiveFrom")),
    effectiveTo: orUndefined(url.searchParams.get("effectiveTo")),
    expiryFrom: orUndefined(url.searchParams.get("expiryFrom")),
    expiryTo: orUndefined(url.searchParams.get("expiryTo")),
  };
}
