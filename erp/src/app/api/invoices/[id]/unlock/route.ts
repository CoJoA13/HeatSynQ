import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { unlockInvoice } from "@/server/invoices";
import { invoiceResponse } from "../../response";

// POST /api/invoices/[id]/unlock — returns a FINALIZED invoice to DRAFT (§5.5). Gated on the
// SPECIAL action alone, the `void_shipper`/`reverseShipper` shape — no `invoicing.*` CRUD
// permission substitutes for it. Reason required and trimmed IN THE SERVICE (`unlockInvoice`).
export const POST = handle(async (req, { params }) => {
  mustDo(requireUser(), "unlock_invoice");
  const body: unknown = await req.json().catch(() => null);
  const detail = await unlockInvoice((await params).id, reasonFromBody(body));
  return invoiceResponse(detail);
});
