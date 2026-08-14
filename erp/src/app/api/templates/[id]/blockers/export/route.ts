import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { findBlockers } from "@/server/reference-blockers";
import { toXlsx } from "@/server/excel";

// Mirrors the surcharge blocker export exactly — same toXlsx column shape — for the
// "documentTemplate" BlockerTarget (the §5.14 delete guard's discoverability half: every
// customer whose live assignment blocks this template's delete, as a workbook).
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "templates", "view");
  const { id } = await params;
  const blockers = await findBlockers("documentTemplate", id);
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
