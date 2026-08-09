import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { agingReport } from "@/server/aging";
import { parseAgingFilter } from "./query";

// GET /api/receivables/aging?customerId=&asOf= — point-in-time A/R aging (Task 10, spec §6). No
// customerId: every customer with A/R history. A plain customer: its own row. A parent with live
// children: the family roll-up (per-child rows plus a synthesized family-total row).
export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const rows = await agingReport(parseAgingFilter(new URL(req.url)));
  return NextResponse.json(rows);
});
