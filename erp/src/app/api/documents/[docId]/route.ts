import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getDocument, travelerFilename } from "@/server/traveler";

/**
 * Streams a stored document's bytes EXACTLY as they were archived (spec §8/§10) — a reprint is a
 * reissue of the file that was printed, never a fresh render. Loads stay editable after a print
 * (§5b), so re-rendering would quietly hand back a different document under the same identity.
 *
 * Not scoped under an order id: `StoredDocument.id` is a cuid on a table with exactly one owner
 * column, so there is no cross-owner id to confuse — the attachment routes need that scoping
 * because two differently-owned tables share one shape; this one does not.
 */
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "orders", "view");
  const { docId } = await params;
  const doc = await getDocument(docId);
  return new NextResponse(new Uint8Array(doc.fileData), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${travelerFilename(doc.orderNumber, doc.loadNumber)}"`,
    },
  });
});
