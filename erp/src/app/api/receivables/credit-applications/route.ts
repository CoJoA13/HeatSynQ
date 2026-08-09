import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { applyCredit } from "@/server/applications";

// POST /api/receivables/credit-applications — apply a finalized CREDIT memo to a finalized
// INVOICE (Task 8, P5B §5). Both guarded balances (the target invoice's open balance and the
// credit's own remaining) are claimed and checked inside `applyCredit` itself; this route is
// authorize-parse-delegate only.
export const POST = handle(async (req) => {
  mustCan(requireUser(), "receivables", "create");
  await applyCredit(await req.json());
  return NextResponse.json({ ok: true });
});
