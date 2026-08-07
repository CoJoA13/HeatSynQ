import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { findBlockers } from "@/server/reference-blockers";

// Mirrors src/app/api/admin/step-codes/[id]/blockers/route.ts exactly — same gating, same
// shape — for the "surcharge" BlockerTarget (Task 6).
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const { id } = await params;
  return NextResponse.json(await findBlockers("surcharge", id));
});
