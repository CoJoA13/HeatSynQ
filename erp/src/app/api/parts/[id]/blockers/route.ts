import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { partOrderBlockers, partQuoteBlockers } from "@/server/parts";

// Task 7 (Phase 6): the panel this route feeds must show BOTH of deletePart's live-row guards,
// not just whichever one happened to throw first (the orders guard fires before the quotes
// guard — parts.ts) — a refusal is not discoverable if half of what's blocking it is left out.
// The customers/[id]/blockers route is the precedent.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "view");
  const { id } = await params;
  const [orders, quotes] = await Promise.all([partOrderBlockers(id), partQuoteBlockers(id)]);
  return NextResponse.json([...orders, ...quotes]);
});
