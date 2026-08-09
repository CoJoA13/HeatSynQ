import { NextResponse } from "next/server";
import { handle, requireUser, HttpError } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listDocumentsForCustomer } from "@/server/documents";

// GET /api/receivables/statements/documents?customerId= — every STATEMENT document archived for
// this customer, newest first (Task 15's statements screen: the 5A `InvoiceDocumentsList`
// precedent, `GET /api/invoices/[id]/documents`). A sibling to `GET /api/receivables/statements`
// (which builds a PREVIEW, not a list) rather than an overload of it — the two answer different
// questions off the same `customerId`, and folding both into one handler would mean branching the
// response shape on which OTHER query params happen to be present. Gated `receivables.view`, the
// build/print route's own gate: no `customers.view` coupling needed since nothing here discloses
// customer master data beyond the id/kind/timestamp already implied by holding receivables.view.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  if (!customerId) throw new HttpError(400, "customerId is required");
  return NextResponse.json(await listDocumentsForCustomer(customerId));
});
