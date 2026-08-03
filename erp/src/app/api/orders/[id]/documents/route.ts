import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listDocuments } from "@/server/traveler";

/** Every traveler ever printed for this order, newest first — metadata only, never the bytes.
 *  Voided orders keep theirs listed (spec §5c: reads work on a voided order). */
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "orders", "view");
  const { id } = await params;
  return NextResponse.json(await listDocuments(id));
});
