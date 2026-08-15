import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportScoreboard } from "@/server/reports/scoreboard";
import { parseScoreboardFilter } from "./query";

// GET /api/reports/scoreboard?from=&to= — the Comparison scoreboard (Task 7, spec §4.3). A read, so
// the only gate is `reports.view`. Three figures for one window: orders entered (by receivedDate),
// shipped pounds/pieces (reused from the Shipped report), and invoiced $ by invoiceDate (net of
// credits). Pure read — no claim, no audit.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  return NextResponse.json(await reportScoreboard(parseScoreboardFilter(new URL(req.url))));
});
