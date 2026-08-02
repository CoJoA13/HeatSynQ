import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { stepFieldBlockers } from "@/server/process-step-codes";
import { toXlsx } from "@/server/excel";

// Mirrors src/app/api/admin/step-codes/[id]/blockers/export/route.ts exactly — same gating, same
// toXlsx column shape — for stepFieldBlockers (see the sibling blockers/route.ts's own comment).
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const { id } = await params;
  const blockers = await stepFieldBlockers(id);
  const buf = await toXlsx("Blockers",
    [{ key: "entityLabel", header: "Type" }, { key: "name", header: "Name" }, { key: "href", header: "Link" }],
    blockers as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Blockers.xlsx"',
    },
  });
});
