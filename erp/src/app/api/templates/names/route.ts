import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { listTemplateNames } from "@/server/template-assignments";

export const GET = handle(async () => {
  const user = requireUser();
  void user; // Session-only gate, DELIBERATELY no area check (§5.15, the /api/picklists
  // precedent): the CUSTOMER page's assignment picker needs template names, and a user holding
  // customers.edit without templates.view must not get a silently empty dropdown — an area gate
  // here would relocate that failure to a role misconfiguration instead of removing it. The
  // projection is the narrowest possible (id/name/docType of live templates — no configs, no
  // counts); managing templates stays behind the `templates` area. Bound to a variable (not a
  // bare `requireUser();`) because tests/permissions-sweep.test.ts requires the call to feed
  // mustCan/mustDo or be assigned — a discarded bare call is indistinguishable from an unused
  // import.
  return NextResponse.json(await listTemplateNames());
});
