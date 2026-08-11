import { NextResponse } from "next/server";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { closeQuote } from "@/server/quotes";

// POST /api/quotes/[id]/close — a deliberate reasoned act under plain `quotes.edit` (spec §5.1:
// reversible and takes nothing with it, so no special action). Reason required and trimmed IN
// THE SERVICE (§5.17). The response carries `linkedOpenOrders` — ruling 6's warn-and-list,
// never a block.
export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "quotes", "edit");
  const body: unknown = await req.json().catch(() => null);
  return NextResponse.json(await closeQuote((await params).id, reasonFromBody(body)));
});
