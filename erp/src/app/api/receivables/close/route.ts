import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { closePeriod } from "@/server/close-periods";

// POST /api/receivables/close — commit the month-end close (spec §4.1). Gated on the dangerous
// `close_ar_period` special on top of `receivables.edit`. The service owns every rule (prior-month,
// zero-variance reconciliation, the month advisory lock).
const BODY = z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) }).strict();

export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "receivables", "edit");
  mustDo(user, "close_ar_period");
  const { year, month } = BODY.parse(await req.json());
  return NextResponse.json(await closePeriod(year, month));
});
