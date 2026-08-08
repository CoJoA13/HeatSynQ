import { NextResponse } from "next/server";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { voidApplication } from "@/server/applications";

// DELETE /api/receivables/applications/[id] — void one application with a reason (trimmed IN THE
// SERVICE, the `voidPayment` precedent). The voided row drops out of every ar-balances sum,
// restoring the invoice open balance and the payment on-account with no compensating write.
export const DELETE = handle(async (req, { params }) => {
  mustCan(requireUser(), "receivables", "delete");
  const body: unknown = await req.json().catch(() => null);
  await voidApplication((await params).id, reasonFromBody(body));
  return NextResponse.json({ ok: true });
});
