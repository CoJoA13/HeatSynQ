import { NextResponse } from "next/server";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { voidPayment } from "@/server/receipts";

// DELETE /api/receivables/batches/[id]/payments/[paymentId] — voids one payment with a reason;
// refuses once the batch is POSTED (Task 6).
export const DELETE = handle(async (req, { params }) => {
  mustCan(requireUser(), "receivables", "delete");
  const body: unknown = await req.json().catch(() => null);
  const { id, paymentId } = await params;
  return NextResponse.json(await voidPayment(id, paymentId, reasonFromBody(body)));
});
