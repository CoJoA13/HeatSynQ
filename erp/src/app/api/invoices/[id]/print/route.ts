import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { printInvoice } from "@/server/invoices";
import { getDocument, resolveDocumentFilename } from "@/server/documents";

/**
 * Renders, archives and streams the invoice/credit (P5A spec §9's `POST /api/invoices/[id]/print`,
 * §10). Gated on `invoicing.view`, deliberately (the cert/traveler/shipping-ticket print
 * precedent): a print changes nothing about the invoice beyond the audited archive of its own
 * output, so it is a read of the document — an explicit POST so §12's "reads never mutate" holds.
 */
export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "invoicing", "view");
  const { id } = await params;

  const printed = await printInvoice(id);
  // The friendly filename (`invoice-72026.pdf` / `credit-1000.pdf`) needs the invoice's order /
  // credit number, which this route does not carry — resolve it off the stored row, the download
  // route's own `resolveDocumentFilename` doctrine (which reads the invoice, never re-renders).
  const filename = await resolveDocumentFilename(await getDocument(printed.documentId));
  return new NextResponse(new Uint8Array(printed.pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      // The stored row this response came from (the traveler/cert route's rule).
      "x-document-id": printed.documentId,
    },
  });
});
