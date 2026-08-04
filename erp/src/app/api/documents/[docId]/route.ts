import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, type Area } from "@/server/permissions";
import { getDocument, documentFilename } from "@/server/documents";

/** `kind` decides the gate: a traveler behind `orders.view`, a shipping ticket or bill of lading
 *  behind `shipping.view`, a certification behind `certs.view` (design spec §9). */
const AREA_BY_KIND: Record<string, Area> = {
  TRAVELER: "orders", SHIPPER: "shipping", BOL: "shipping", CERT: "certs",
};

/**
 * Streams a stored document's bytes EXACTLY as they were archived (spec §8/§10) — a reprint is a
 * reissue of the file that was printed, never a fresh render. Loads stay editable after a print
 * (§5b), so re-rendering would quietly hand back a different document under the same identity.
 *
 * Not scoped under an owner id: `StoredDocument.id` is a cuid on a table with exactly one owner
 * PER KIND, so there is no cross-owner id to confuse — the attachment routes need that scoping
 * because two differently-owned tables share one shape; this one does not.
 *
 * Phase 4 Task 3 widened this gate: with four document kinds behind three different areas, the
 * permission cannot be chosen until the row's `kind` is known, so the metadata read comes first
 * and `mustCan` runs against it — never before it. `getDocument` returns the bytes in the same
 * read rather than a separate metadata-only fetch (documents.ts has no such split, and this route
 * is not the place to add one), but nothing in this response reaches the caller until the
 * permission check clears.
 */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const { docId } = await params;
  const doc = await getDocument(docId);
  mustCan(user, AREA_BY_KIND[doc.kind], "view");
  return new NextResponse(new Uint8Array(doc.fileData), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${documentFilename(doc)}"`,
    },
  });
});
