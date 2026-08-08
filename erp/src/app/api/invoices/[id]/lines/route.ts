import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { replaceInvoiceLines } from "@/server/invoices";
import { invoiceResponse } from "../../response";

// PUT /api/invoices/[id]/lines — whole-array replace of a DRAFT's lines (§5.5). This changes what
// is billed, so it is gated on `invoicing.edit` AND `change_prices` — the
// `customers/[id]/surcharges` mustCan+mustDo shape (task-16-brief.md's binding requirement,
// carried in from Task 12's review). The service layer is deliberately permission-free
// (`invoices.ts`'s own header comment); this route is the only place `change_prices` is enforced.
export const PUT = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "invoicing", "edit");
  mustDo(user, "change_prices");
  const detail = await replaceInvoiceLines((await params).id, await req.json());
  return invoiceResponse(detail);
});
