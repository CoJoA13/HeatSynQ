import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { findBlockers } from "@/server/reference-blockers";

// Mirrors src/app/api/admin/reference/[kind]/[id]/blockers/route.ts exactly — same gating, same
// shape — for the one BlockerTarget that isn't a ReferenceKind (spec §7).
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const { id } = await params;
  return NextResponse.json(await findBlockers("processStepCode", id));
});
