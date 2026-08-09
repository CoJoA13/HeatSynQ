import { NextResponse } from "next/server";
import { handle, requireUser, HttpError } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { applyPayment, discountAvailable, invoiceOpenBalanceById, openInvoicesForPayer } from "@/server/applications";

// GET /api/receivables/applications — two read shapes over the same `receivables.view` gate, the
// `/api/invoices` `?candidates=1` precedent (one route, switched by which params are present):
//   - `?customerId=` — the payer's (and, when it has a parent/children, its family's) open
//     finalized invoices (Task 13's batch-apply screen: which invoices are even pickable).
//   - `?paymentId=&invoiceId=` — one candidate's live open balance plus the eligible early-pay
//     discount for THIS payment settling it (0 out of window / no terms discount). The apply
//     panel reads this once a specific invoice is chosen, to show the live balance and prefill a
//     DISCOUNT line only when `discount > 0`.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId");
  if (customerId) return NextResponse.json(await openInvoicesForPayer(customerId));

  const paymentId = url.searchParams.get("paymentId") ?? "";
  const invoiceId = url.searchParams.get("invoiceId") ?? "";
  if (!paymentId || !invoiceId) throw new HttpError(400, "paymentId and invoiceId are required");
  const [open, discount] = await Promise.all([
    invoiceOpenBalanceById(invoiceId), discountAvailable(paymentId, invoiceId),
  ]);
  return NextResponse.json({ open, discount });
});

// POST /api/receivables/applications — apply a payment across one or more invoices in ONE sorted
// claim (Task 7, P5B §4.1). Route-level `write_off` gating for WRITE_OFF lines is Task 16's sweep.
export const POST = handle(async (req) => {
  mustCan(requireUser(), "receivables", "create");
  await applyPayment(await req.json());
  return NextResponse.json({ ok: true });
});
