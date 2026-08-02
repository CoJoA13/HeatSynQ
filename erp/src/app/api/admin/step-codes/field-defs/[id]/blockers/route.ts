import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { stepFieldBlockers } from "@/server/process-step-codes";

// Mirrors src/app/api/admin/step-codes/[id]/blockers/route.ts exactly — same gating, same shape
// — for the one blocker source that isn't keyed on a BlockerTarget at all: a ProcessStepFieldDef
// id, scoped through step -> revision -> part (see stepFieldBlockers's own doc comment,
// process-step-codes.ts). Finding 1 of the 2C-3 final-review fix wave: `stepFieldBlockers` existed
// and was tested but nothing consumed it — the field-save failure path only showed a count, no
// discoverable blockers (spec §5.14).
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const { id } = await params;
  return NextResponse.json(await stepFieldBlockers(id));
});
