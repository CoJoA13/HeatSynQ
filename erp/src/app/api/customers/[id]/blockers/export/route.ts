import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { customerPartBlockers, customerOrderBlockers, customerQuoteBlockers } from "@/server/customers";
import { toXlsx } from "@/server/excel";

// Same three-way union as the sibling blockers route (Task 15 parts+orders, Task 7 quotes): the
// workbook must carry every category of blocker, whichever guard actually threw.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  const { id } = await params;
  const [parts, orders, quotes] = await Promise.all([
    customerPartBlockers(id), customerOrderBlockers(id), customerQuoteBlockers(id)]);
  const blockers = [...parts, ...orders, ...quotes];
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
