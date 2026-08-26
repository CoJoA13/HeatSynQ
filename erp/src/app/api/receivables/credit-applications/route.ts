import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { applyCredit } from "@/server/applications";

// POST /api/receivables/credit-applications — apply a finalized CREDIT memo to a finalized
// INVOICE (Task 8, P5B §5). Allocating a credit moves value between open items the same way a
// cash application does, so it takes the same `apply_payments` named action the payment-apply
// route gates on (#211, owner ruling 2026-08-25). Both guarded balances (the target invoice's
// open balance and the credit's own remaining) are claimed and checked inside `applyCredit`
// itself; this route is authorize-parse-delegate only.
export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "receivables", "create");
  mustDo(user, "apply_payments");
  await applyCredit(await req.json());
  return NextResponse.json({ ok: true });
});
