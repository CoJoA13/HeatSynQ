import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { quoteOrderBlockers } from "@/server/quotes";
import { toXlsx } from "@/server/excel";

// The §5.14 discoverability ride-along (the parts/[id]/blockers/export shape): the orders that
// refuse this quote's delete, as a workbook the operator can take to the floor.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "quotes", "view");
  const blockers = await quoteOrderBlockers((await params).id);
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
