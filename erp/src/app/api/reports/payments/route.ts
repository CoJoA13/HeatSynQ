import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportPayments } from "@/server/reports/payments";
import { parsePaymentsFilter } from "./query";

// GET /api/reports/payments?customerId=&from=&to=&groupBy= — the Payments-received report (Task 5,
// spec §4.2). A read, so the only gate is `reports.view`. POSTED-batch cash received, anchored on
// receivedDate; groupBy slices the base grain by customer / received-month / payment type. The
// result carries the `basis` string ("Posted payments only") so the screen can print it.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  return NextResponse.json(await reportPayments(parsePaymentsFilter(new URL(req.url))));
});
