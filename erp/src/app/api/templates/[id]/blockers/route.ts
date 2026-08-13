import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { findBlockers } from "@/server/reference-blockers";

// The §5.14 blocker LIST for a document template — the linked-rows counterpart to the sibling
// /blockers/export workbook (Task 4). admin/templates/page.tsx reads this ONLY after a delete is
// refused with a 400 (carried Task-4 minor b: the export, and now this list too, are reachable
// from the delete refusal alone, never as a standalone control). The blocker a person can act on
// is the CUSTOMER whose live assignment points at this template (reference-links.ts's
// customerTemplateAssignment -> documentTemplate entry); clearing the assignment on the customer
// page (Task 20) unblocks the delete. No `includeModel` — unlike the surcharge panel, this list
// has no in-place "clear" escape hatch, so it needs no per-link discriminator.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "templates", "view");
  const { id } = await params;
  return NextResponse.json(await findBlockers("documentTemplate", id));
});
