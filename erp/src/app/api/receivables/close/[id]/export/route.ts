import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { exportClose } from "@/server/gl-export";

// POST /api/receivables/close/[id]/export — emit the per-event GL-export delta batch for a CLOSED
// period (spec §4.3). Gated on the dangerous `run_qbo_export` special on top of `receivables.edit`;
// the service owns every rule (readiness refusal, the delta, the Serializable write).
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "receivables", "edit");
  mustDo(user, "run_qbo_export");
  const { id } = await params;
  return NextResponse.json(await exportClose(id));
});
