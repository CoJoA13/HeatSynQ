import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { closePeriod, listClosePeriods } from "@/server/close-periods";

// GET /api/receivables/close — Task 8's gap fill: list every closed/reopened period with its
// frozen schedule figures and its GL-export batches, for the `/receivables/close` screen's
// closed-periods panel. A read, gated on `receivables.view` alone (the `batches/route.ts`
// GET-list-alongside-POST-create precedent).
export const GET = handle(async () => {
  mustCan(requireUser(), "receivables", "view");
  return NextResponse.json(await listClosePeriods());
});

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
