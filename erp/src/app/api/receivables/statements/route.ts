import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser, HttpError } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { buildStatement, printStatement, hasLiveDivisions } from "@/server/statements";
import { getDocument, resolveDocumentFilename } from "@/server/documents";
import { contentDispositionValue } from "@/server/content-disposition";

// GET /api/receivables/statements?customerId=&asOf=&combineFamily=&assessFinanceCharges= —
// builds (does NOT archive) one customer's — or its family's — open-item statement (Task 12,
// P5B §8). A preview: the statements screen reads this before the user commits to a print. Gated
// receivables.view, the `aging`/`applications` GET precedent.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  if (!customerId) throw new HttpError(400, "customerId is required");
  const asOf = url.searchParams.get("asOf") ?? undefined;
  const combineFamily = url.searchParams.get("combineFamily") === "true";
  const assessFinanceCharges = url.searchParams.get("assessFinanceCharges") === "true";
  return NextResponse.json(await buildStatement(customerId, { asOf, combineFamily, assessFinanceCharges }));
});

const PRINT = z.object({
  customerId: z.string().min(1),
  asOf: z.string().optional(),
  combineFamily: z.boolean().optional(),
  assessFinanceCharges: z.boolean().optional(),
}).strict();

// POST /api/receivables/statements — render, archive and stream one customer's (or family's)
// statement (Task 12, P5B §8) — the `invoices/[id]/print` route's own shape. Gated
// receivables.view: like every other document print in this codebase, this changes nothing about
// A/R itself beyond the audited archive of its own output, so it is a read of the DOCUMENT, not a
// write of the account (an explicit POST only because it isn't idempotent — each call archives a
// new document).
export const POST = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const body = PRINT.parse(await req.json());
  // #136 (owner ruling 2026-08-17: a parent-only statement is never wanted). An UN-combined print of
  // a customer WITH divisions is the per-division choice, and answering it here with the parent
  // alone silently omits every division — #85's original symptom. The screen also picks the right
  // path, but it does so from a customer list that has been wrong three different ways across review
  // (active-only, not yet loaded, stale), so the authoritative answer belongs on this side: a stale
  // client can now only produce this refusal, never a quietly incomplete statement run.
  if (body.combineFamily !== true && await hasLiveDivisions(body.customerId)) {
    throw new HttpError(409,
      "That customer has divisions — use Print per division, or tick Combine family");
  }
  const printed = await printStatement(body.customerId, {
    asOf: body.asOf,
    combineFamily: body.combineFamily ?? false,
    assessFinanceCharges: body.assessFinanceCharges ?? false,
  });
  const filename = await resolveDocumentFilename(await getDocument(printed.documentId));
  return new NextResponse(new Uint8Array(printed.pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      // Sanitized through the shared leaf (issue #87): a customer `code` carrying a newline/quote
      // is stripped/escaped here rather than crashing the `Headers` constructor AFTER the archive
      // above already committed.
      "content-disposition": contentDispositionValue("inline", filename),
      "x-document-id": printed.documentId,
    },
  });
});
