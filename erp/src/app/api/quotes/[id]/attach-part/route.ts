import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { attachPart } from "@/server/quotes";

// POST /api/quotes/[id]/attach-part — sets `partId` on a live free-text line (spec §4.1,
// ruling 1: an audited quotes.edit action; from then on the line auto-links). The `{ lineId,
// partId }` body is `.strict()`-parsed in the service.
export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "quotes", "edit");
  return NextResponse.json(await attachPart((await params).id, await req.json()));
});
