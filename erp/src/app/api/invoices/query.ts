// Not a route — the shippers/query.ts precedent: GET /api/invoices and its future export route
// (Task 17) must agree on exactly what a given query string means, so the parse lives here once.
import { HttpError } from "@/server/http";
import type { InvoiceFilter } from "@/server/invoices";
import { INVOICE_STATUSES } from "@/lib/invoice-constants";

/** An absent param and a blank one both mean "not set" — the orders/query.ts `orUndefined`
 *  precedent, duplicated rather than imported (the shippers/query.ts precedent: not worth the
 *  cross-tree coupling for a four-line helper). */
function orUndefined(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

const STATUS_VALUES = new Set<string>(INVOICE_STATUSES);

/** Rejects an unrecognized status as a field-anchored 400 naming it (the orders/query.ts
 *  `parseStatus` precedent) rather than handing Prisma a value its enum has never heard of, which
 *  throws a status-less `PrismaClientValidationError` there — a bare 500 instead of a clean 400. */
function parseStatus(url: URL): InvoiceFilter["status"] {
  const raw = orUndefined(url.searchParams.get("status"));
  if (raw === undefined) return undefined;
  if (!STATUS_VALUES.has(raw)) throw new HttpError(400, `Unknown invoice status "${raw}"`);
  return raw as InvoiceFilter["status"];
}

/** Turns the invoicing list's query string into the `InvoiceFilter` shape `listInvoices` expects.
 *  `from`/`to` pass through unvalidated on purpose — `listInvoices` already turns a malformed date
 *  into its own field-anchored 400 via `parseDate`, so re-checking here would just be a second
 *  copy of a rule the service already owns (the shippers/query.ts precedent). */
export function parseInvoiceFilter(url: URL): InvoiceFilter {
  return {
    customerId: orUndefined(url.searchParams.get("customerId")),
    status: parseStatus(url),
    from: orUndefined(url.searchParams.get("from")),
    to: orUndefined(url.searchParams.get("to")),
  };
}

/** `?candidates=1` switches GET /api/invoices from the invoice list to the ready-to-invoice
 *  worklist (`listInvoiceCandidates`) — the same query string, two different reads, so the route
 *  needs one place that decides which. */
export function isCandidatesQuery(url: URL): boolean {
  return url.searchParams.get("candidates") === "1";
}
