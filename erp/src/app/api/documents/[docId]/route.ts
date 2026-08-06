import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getDocument, resolveDocumentFilename, AREA_FOR_KIND } from "@/server/documents";

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
 * and `mustCan` runs against it — never before it, against `AREA_FOR_KIND` (documents.ts — the one
 * source of truth this route shares with `listDocumentsForOrder`'s own per-kind filtering).
 * `getDocument` returns the bytes in the same read rather than a separate metadata-only fetch
 * (documents.ts has no such split, and this route is not the place to add one), but nothing in
 * this response reaches the caller until the permission check clears.
 *
 * The download filename comes from `resolveDocumentFilename` (documents.ts), which looks up the
 * friendly order/shipper number this route does not otherwise have on hand — a review-round-2 fix:
 * the initial extraction called the synchronous `documentFilename(doc)` with no number argument,
 * so every download regressed to a raw-cuid filename (`traveler-<cuid>.pdf`) instead of the
 * `traveler-71246.pdf` the pre-extraction code produced via its own `order` join.
 */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const { docId } = await params;
  const doc = await getDocument(docId);
  mustCan(user, AREA_FOR_KIND[doc.kind], "view");
  return new NextResponse(new Uint8Array(doc.fileData), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${await resolveDocumentFilename(doc)}"`,
    },
  });
});
