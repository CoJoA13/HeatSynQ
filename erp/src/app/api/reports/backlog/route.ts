import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportBacklog } from "@/server/reports/backlog";
import { parseBacklogFilter } from "./query";

// GET /api/reports/backlog?customerId=&partId=&from=&to=&groupBy= — the Backlog report (Task 1,
// spec §4.2). A read, so the only gate is `reports.view`. Open order lines of orders not yet fully
// shipped (OPEN/PARTIAL_SHIPPED/REOPENED); groupBy slices the base grain by customer/part/month.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  return NextResponse.json(await reportBacklog(parseBacklogFilter(new URL(req.url))));
});
