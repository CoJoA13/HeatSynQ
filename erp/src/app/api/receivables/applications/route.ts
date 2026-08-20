import { NextResponse } from "next/server";
import { handle, requireUser, HttpError } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { applyPayment, discountOffer, invoiceOpenBalanceById, openInvoicesForPayer } from "@/server/applications";

/**
 * Peeks at a raw POST body for a WRITE_OFF line, before `applyPayment`'s own zod parse. Only
 * needs to recognize the same `lines`/`type` shape the `APPLY` schema (applications.ts) already
 * requires — any body that reaches a WRITE_OFF line inside `applyPaymentInTx` must already match
 * this shape, so a loose type-guard here never lets a real write-off through ungated. A body that
 * DOESN'T match still reaches `applyPayment`, which reports its own 400 via zod.
 */
function hasWriteOffLine(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const lines = (body as Record<string, unknown>).lines;
  if (!Array.isArray(lines)) return false;
  return lines.some((line) => typeof line === "object" && line !== null && (line as Record<string, unknown>).type === "WRITE_OFF");
}

// GET /api/receivables/applications — two read shapes over the same `receivables.view` gate, the
// `/api/invoices` `?candidates=1` precedent (one route, switched by which params are present):
//   - `?customerId=` — the payer's (and, when it has a parent/children, its family's) open
//     finalized invoices (Task 13's batch-apply screen: which invoices are even pickable).
//   - `?paymentId=&invoiceId=` — one candidate's live open balance plus the early-pay discount
//     offer for THIS payment settling it. `discount` is `DiscountOffer` (applications.ts), NOT a
//     bare number: since #155 arm 2 it carries WHY the figure is zero, and — for the one blocker an
//     operator can act on — the two figures the apply grid's hint is built from. The panel prefills
//     a DISCOUNT line only when `discount.amount > 0`.
export const GET = handle(async (req) => {
  mustCan(requireUser(), "receivables", "view");
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId");
  if (customerId) return NextResponse.json(await openInvoicesForPayer(customerId));

  const paymentId = url.searchParams.get("paymentId") ?? "";
  const invoiceId = url.searchParams.get("invoiceId") ?? "";
  if (!paymentId || !invoiceId) throw new HttpError(400, "paymentId and invoiceId are required");
  const [open, discount] = await Promise.all([
    invoiceOpenBalanceById(invoiceId), discountOffer(paymentId, invoiceId),
  ]);
  return NextResponse.json({ open, discount });
});

// POST /api/receivables/applications — apply a payment across one or more invoices in ONE sorted
// claim (Task 7, P5B §4.1). A body carrying ANY WRITE_OFF line additionally requires the
// `write_off` special action (spec §9, Task 16) — `receivables.create` alone lets a session
// record PAYMENT/DISCOUNT lines but not waive a balance. Gate order: mustCan(create) → parse →
// conditional mustDo(write_off) → delegate.
export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "receivables", "create");
  const body: unknown = await req.json();
  if (hasWriteOffLine(body)) mustDo(user, "write_off");
  await applyPayment(body);
  return NextResponse.json({ ok: true });
});
