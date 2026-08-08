import { NextResponse } from "next/server";
import { handle, requireUser, HttpError } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { applyPayment, discountAvailable } from "@/server/applications";

// GET /api/receivables/applications?paymentId=&invoiceId= — the eligible early-pay discount for a
// payment settling this invoice (0 out of window / no terms discount). The batch-apply grid reads
// it to prefill a DISCOUNT line (Task 16/17).
export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const url = new URL(req.url);
  const paymentId = url.searchParams.get("paymentId") ?? "";
  const invoiceId = url.searchParams.get("invoiceId") ?? "";
  if (!paymentId || !invoiceId) throw new HttpError(400, "paymentId and invoiceId are required");
  return NextResponse.json({ discount: await discountAvailable(paymentId, invoiceId) });
});

// POST /api/receivables/applications — apply a payment across one or more invoices in ONE sorted
// claim (Task 7, P5B §4.1). Route-level `write_off` gating for WRITE_OFF lines is Task 16's sweep.
export const POST = handle(async (req) => {
  mustCan(requireUser(), "receivables", "create");
  await applyPayment(await req.json());
  return NextResponse.json({ ok: true });
});
