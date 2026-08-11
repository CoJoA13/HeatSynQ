import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { partOrderBlockers, partQuoteBlockers } from "@/server/parts";
import { toXlsx } from "@/server/excel";

// Same union as the sibling blockers route (Task 7): the workbook must carry every category of
// blocker, orders and quotes both, whichever guard actually threw.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "view");
  const { id } = await params;
  const [orders, quotes] = await Promise.all([partOrderBlockers(id), partQuoteBlockers(id)]);
  const blockers = [...orders, ...quotes];
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
