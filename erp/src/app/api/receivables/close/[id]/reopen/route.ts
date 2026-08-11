import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { reopenPeriod } from "@/server/close-periods";

// POST /api/receivables/close/[id]/reopen — soft-reopen a closed month with a mandatory reason
// (spec §4.1). Same gating shape as the close (`receivables.edit` + the `close_ar_period` special);
// the service requires the non-empty reason and records it in the audit entry.
const BODY = z.object({ reason: z.string() }).strict();

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "receivables", "edit");
  mustDo(user, "close_ar_period");
  const { id } = await params;
  const { reason } = BODY.parse(await req.json());
  return NextResponse.json(await reopenPeriod(id, reason));
});
