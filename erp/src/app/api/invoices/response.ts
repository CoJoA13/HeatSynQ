// Not a route — the shippers/response.ts precedent. Every invoice mutator in invoices.ts
// returns a bare `InvoiceDetail`, with the §5.8 needs-price/no-GL-account warnings exposed only
// through the separate pure `invoiceWarnings` export — nothing obliges a caller to invoke it, so
// `return NextResponse.json(await updateInvoice(...))` would silently drop the warning a screen
// is supposed to show. Every route that returns a single invoice (GET included — the shipment
// page's own "warnings on a plain load, not only right after an edit" reasoning applies here
// too) wraps its response through this ONE function instead of eight hand-copied call sites that
// could drift apart.
import { NextResponse } from "next/server";
import { invoiceWarnings, type InvoiceDetail } from "@/server/invoices";

export async function invoiceResponse(detail: InvoiceDetail): Promise<NextResponse> {
  return NextResponse.json({ invoice: detail, warnings: await invoiceWarnings(detail) });
}
