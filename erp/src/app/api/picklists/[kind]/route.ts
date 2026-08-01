import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { listPickList } from "@/server/picklists";

export const GET = handle(async (req, { params }) => {
  const user = requireUser();
  void user; // Session-only gate: presence of a signed-in user is the whole check, no permission
  // beyond that. Bound to a variable (not a bare `requireUser();`) because
  // tests/permissions-sweep.test.ts's "every API route calls requireUser" check requires the
  // call to feed mustCan/mustDo or be assigned — a discarded bare call is indistinguishable
  // from a route that imports requireUser but never actually calls it.
  const { kind } = await params;
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  return NextResponse.json(await listPickList(kind, { includeInactive }));
});
