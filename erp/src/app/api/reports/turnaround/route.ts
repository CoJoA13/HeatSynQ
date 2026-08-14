import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportTurnaround } from "@/server/reports/turnaround";
import { parseTurnaroundFilter } from "./query";

// GET /api/reports/turnaround?customerId=&partId=&from=&to=&groupBy= — the Turnaround report (Task 3,
// spec §4.2 / §12). A read, so the only gate is `reports.view`. Average order-to-ship days over
// currently-SHIPPED orders, the completion date derived from shipments; groupBy slices the base
// grain by customer/part/completion-month, and from/to range on the derived completion date.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  return NextResponse.json(await reportTurnaround(parseTurnaroundFilter(new URL(req.url))));
});
