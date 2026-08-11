import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { preliminaryReport } from "@/server/close-periods";

// GET /api/receivables/close/preliminary?year=&month= — the read-only preliminary closing report
// (spec §4.1): the continuity schedule + variance, the un-posted-batch count, and whether the month
// is already closed. A read, so gated on `receivables.view` only.
// year >= 2000 (matching readiness/period.ts and the close route): a year of 0-99 would let
// `Date.UTC(year, …)` silently remap the window into 1900-1999.
const QUERY = z.object({
  year: z.coerce.number().int().min(2000),
  month: z.coerce.number().int().min(1).max(12),
}).strict();

export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const url = new URL(req.url);
  const { year, month } = QUERY.parse({
    year: url.searchParams.get("year") ?? undefined,
    month: url.searchParams.get("month") ?? undefined,
  });
  return NextResponse.json(await preliminaryReport(year, month));
});
