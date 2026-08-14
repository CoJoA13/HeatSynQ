import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { readPreviewContext, renderPreview, RECORD_AREA } from "@/server/template-preview";

/**
 * POST /api/templates/[id]/preview — the side-effect-free preview (Phase 7 spec §5.5): renders the
 * editor's SUBMITTED (working, possibly-unsaved) config against a real record the user picks, and
 * streams the PDF bytes. It writes NOTHING — no `StoredDocument`, no `printedAt`, no finance-charge
 * assessment, no `updatedAt` bump, no number allocation.
 *
 * Gated on `templates.view` PLUS the record's own print-route permission (`RECORD_AREA[docType]`) —
 * a preview exposes the real record's amounts, so it must never be a cheaper read than the print.
 * The record area depends on the template's docType, so the template is read (docType only, no
 * record data) between the two gates; the record itself is read only after both pass.
 */
const BODY = z.object({
  // A loose object here: the SERVICE validates it against the docType's contract (shape → ZodError,
  // rule → a named 400) — the route only refuses a non-object early (the draft-edit route's shape).
  config: z.looseObject({}),
  recordId: z.string().min(1),
  asOf: z.string().optional(),
  combineFamily: z.boolean().optional(),
  loadNumber: z.number().int().positive().optional(),
}).strict();

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "templates", "view");
  const { id } = await params;
  const ctx = await readPreviewContext(id);
  mustCan(user, RECORD_AREA[ctx.docType], "view");

  const body = BODY.parse(await req.json());
  const pdf = await renderPreview(ctx, body, user.id);
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="preview.pdf"`,
    },
  });
});
