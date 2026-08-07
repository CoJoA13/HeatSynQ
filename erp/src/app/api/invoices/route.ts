import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { createInvoice, listInvoices, listInvoiceCandidates } from "@/server/invoices";
import { parseInvoiceFilter, isCandidatesQuery } from "./query";

// GET /api/invoices — the invoice list, or (?candidates=1) the ready-to-invoice worklist. Both
// are reads over the same `invoicing.view` gate; `createInvoice` (spec §5.4) is the only writer.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "invoicing", "view");
  const url = new URL(req.url);
  const filter = parseInvoiceFilter(url);
  if (isCandidatesQuery(url)) return NextResponse.json(await listInvoiceCandidates(filter));
  return NextResponse.json(await listInvoices(filter));
});

// POST /api/invoices — `createInvoice` already returns `{ invoice, warnings, deduped }` (§7.5's
// full surface plus the idempotent-replay flag), so this returns it as-is rather than through
// `invoiceResponse` (which wraps a bare `InvoiceDetail`, not this richer create-result shape).
export const POST = handle(async (req) => {
  mustCan(requireUser(), "invoicing", "create");
  const result = await createInvoice(await req.json());
  return NextResponse.json(result);
});
