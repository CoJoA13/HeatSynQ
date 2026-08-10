import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { preliminaryReport } from "@/server/close-periods";

// GET /api/receivables/close/preliminary?year=&month= — the read-only preliminary closing report
// (spec §4.1): the continuity schedule + variance, the un-posted-batch count, and whether the month
// is already closed. A read, so gated on `receivables.view` only.
const QUERY = z.object({
  year: z.coerce.number().int(),
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
