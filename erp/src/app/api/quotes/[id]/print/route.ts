import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { printQuote } from "@/server/quotes";
import { documentFilename } from "@/server/documents";

/**
 * Renders, archives and streams the quote (Phase 6 spec §6 — the eighth document type).
 *
 * Gated on `quotes.view`, deliberately (the traveler/cert/invoice print precedent): a print
 * changes nothing about the quote beyond the audited archive of its own output, so it is a read
 * of the document — an explicit POST so §12's "reads never mutate" holds. Reprints of a STORED
 * document are the download route's job (`GET /api/documents/[docId]`, byte-exact), never a
 * re-render here.
 *
 * The friendly filename is built the cert route's way: `printQuote` already returns the quote
 * number, so no `resolveDocumentFilename` lookup is needed.
 */
export const POST = handle(async (_req, { params }) => {
  mustCan(requireUser(), "quotes", "view");
  const { id } = await params;

  const printed = await printQuote(id);
  const filename = documentFilename(
    { id: "", createdAt: new Date(0), kind: "QUOTE",
      orderId: null, shipperId: null, certId: null, invoiceId: null, customerId: null,
      quoteId: id, loadNumber: null },
    undefined, undefined, undefined, undefined, printed.quoteNumber,
  );
  return new NextResponse(new Uint8Array(printed.pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      // The stored row this response came from (the traveler route's rule).
      "x-document-id": printed.documentId,
    },
  });
});
