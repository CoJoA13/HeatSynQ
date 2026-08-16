import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { installReadiness } from "@/server/install-readiness";

// The setup checklist (Phase 8B §5.5) reads this. Admin authority — GL-account entry and the other
// steps are admin-only (§8). A pure read.
export const GET = handle(async () => {
  mustCan(requireUser(), "admin", "view");
  return NextResponse.json(await installReadiness());
});
