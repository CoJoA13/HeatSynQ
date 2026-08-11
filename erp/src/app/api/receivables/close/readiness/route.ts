import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { readinessForExport } from "@/server/gl-export";
import { parseReadinessPeriod } from "./period";

// GET /api/receivables/close/readiness?year=&month= — the GL-export readiness gap list for a period
// (spec §7). A read, gated on `receivables.view`. Period-scoped so the UI's readiness panel and its
// disabled export-count read the SAME period end `exportClose` refuses on — the two can never
// disagree about whether the export may proceed.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const periodEnd = parseReadinessPeriod(new URL(req.url));
  return NextResponse.json(await readinessForExport(periodEnd));
});
