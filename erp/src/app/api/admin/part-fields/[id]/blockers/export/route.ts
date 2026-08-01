import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { partFieldDefBlockers } from "@/server/part-field-defs";
import { toXlsx } from "@/server/excel";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const blockers = await partFieldDefBlockers((await params).id);
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
