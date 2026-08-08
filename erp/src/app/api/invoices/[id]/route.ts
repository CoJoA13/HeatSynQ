import { NextResponse } from "next/server";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getInvoice, updateInvoice, discardInvoice } from "@/server/invoices";
import { invoiceResponse } from "../response";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "invoicing", "view");
  // Wrapped through `invoiceResponse` (the shipperResponse precedent): the invoice page remounts
  // per id and renders §5.8's warnings as banners on a plain load, not only right after an edit.
  return invoiceResponse(await getInvoice((await params).id));
});

// Header-only draft edit (§5.5) — PO/date/terms/addresses. Does not touch a line's money, so
// `invoicing.edit` alone gates it; the money-changing edits (lines, recalculate, credit) also
// require `change_prices` (task-16-brief.md's binding requirement, folded in from Task 12's
// review — see those routes).
export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "invoicing", "edit");
  const detail = await updateInvoice((await params).id, await req.json());
  return invoiceResponse(detail);
});

// Discard a DRAFT that has never printed (§5.5/§5.17) — `invoicing.delete`, reason required and
// trimmed IN THE SERVICE (`discardInvoice`), the `voidShipper`/`reasonFromBody` shape.
export const DELETE = handle(async (req, { params }) => {
  mustCan(requireUser(), "invoicing", "delete");
  const body: unknown = await req.json().catch(() => null);
  await discardInvoice((await params).id, reasonFromBody(body));
  return NextResponse.json({ ok: true });
});
