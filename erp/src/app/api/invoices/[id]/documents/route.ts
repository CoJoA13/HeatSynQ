import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listDocumentsForInvoice } from "@/server/documents";

/**
 * Every `INVOICE`/`CREDIT` document filed against this invoice — metadata only, never the bytes
 * (design spec §11's invoice page: "Documents; History"). No cross-kind union to filter, the way
 * `GET /api/orders/[id]/documents` needs one: the only kinds `listDocumentsForInvoice` can ever
 * return sit behind the SAME `invoicing` area this route itself gates on, so nothing here can leak
 * a kind the caller couldn't already see by holding `invoicing.view` in the first place. Mirrors
 * `GET /api/certs/[id]/documents` / `GET /api/shippers/[id]/documents` exactly.
 *
 * This route did not exist before Task 20. `InvoiceDetail.tsx`'s own Documents section (Task 18)
 * already called it, on the explicit license that a later task would build the print/archive path
 * first — Task 19 built `printInvoice` and the print route but never added this list route, so
 * every real print left the invoice page's own Documents panel 404ing. Task 20's E2E flow is the
 * first to exercise print-then-view-the-list, which is what found the gap; closed here rather than
 * worked around, since the flow's whole point is to pin this exact seam.
 */
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "invoicing", "view");
  return NextResponse.json(await listDocumentsForInvoice((await params).id));
});
