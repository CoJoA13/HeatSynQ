import { NextResponse } from "next/server";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reopenQuote } from "@/server/quotes";

// POST /api/quotes/[id]/reopen — the close's inverse, same permission, same §5.17 reason rule.
export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "quotes", "edit");
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await reopenQuote((await params).id, reasonFromBody(body)));
});
