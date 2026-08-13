import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { setDefault } from "@/server/templates";

// Set-default changes what future paper looks like — area edit AND the `edit_templates` special
// (spec §7, the change_prices pattern).
export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "templates", "edit");
  mustDo(user, "edit_templates");
  const { id } = await params;
  await setDefault(id);
  return NextResponse.json({ ok: true });
});
