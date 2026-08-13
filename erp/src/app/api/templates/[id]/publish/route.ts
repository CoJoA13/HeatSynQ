import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { publishDraft } from "@/server/templates";

// Publish changes what future paper looks like — area edit AND the `edit_templates` special
// (spec §7, the change_prices pattern).
export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "templates", "edit");
  mustDo(user, "edit_templates");
  const { id } = await params;
  return NextResponse.json(await publishDraft(id));
});
