import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportShipped } from "@/server/reports/shipped";
import { parseShippedFilter } from "./query";

// GET /api/reports/shipped?customerId=&partId=&from=&to=&groupBy= — the Shipped report (Task 2,
// spec §4.2). A read, so the only gate is `reports.view`. Actual shipped volume windowed on
// Shipper.shipDate; groupBy slices the base grain by customer/part/ship-month/day.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  return NextResponse.json(await reportShipped(parseShippedFilter(new URL(req.url))));
});
