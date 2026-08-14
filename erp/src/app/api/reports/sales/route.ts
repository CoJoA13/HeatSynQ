import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportSales } from "@/server/reports/sales";
import { parseSalesFilter } from "./query";

// GET /api/reports/sales?customerId=&from=&to=&groupBy= — the Sales report (Task 4, spec §4.2/§8).
// A read, so the only gate is `reports.view`. Invoiced revenue excluding sales tax, net of credits,
// recognized by `finalizedAt`; groupBy slices the base grain by customer / part / finalized-month.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  return NextResponse.json(await reportSales(parseSalesFilter(new URL(req.url))));
});
