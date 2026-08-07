import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { finalizeInvoice } from "@/server/invoices";
import { invoiceResponse } from "../../response";

// POST /api/invoices/[id]/finalize — locks a DRAFT (§5.5). Freezes the CURRENT lines and
// re-prices nothing, so it changes lifecycle, not money — `invoicing.edit` alone, no
// `change_prices`. Calls the no-`tx` `finalizeInvoice(id)` form: the `tx`-taking overload exists
// only for the discriminating concurrency test, and the no-`tx` form is what wraps the write in
// the Serializable transaction + `withDbErrors` error mapping (task-16-brief.md's binding
// requirement, carried in from Task 13's review).
export const POST = handle(async (_req, { params }) => {
  mustCan(requireUser(), "invoicing", "edit");
  const detail = await finalizeInvoice((await params).id);
  return invoiceResponse(detail);
});
