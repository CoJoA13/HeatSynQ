import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { createCredit } from "@/server/invoices";
import { invoiceResponse } from "../../response";

// POST /api/invoices/[id]/credit — raises a DRAFT credit against a finalized invoice (§5.6). It
// is a new money-bearing document (`invoicing.create`, the `createInvoice` precedent) that copies
// every line with its amount sign flipped, so it ALSO requires `change_prices`
// (task-16-brief.md's binding requirement, carried in from Task 12's review — named explicitly
// alongside the line replace and recalculate routes). Calls the no-`tx` `createCredit(id)` form —
// there is no `tx`-taking overload on this one, only the wrapped bracket.
export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "invoicing", "create");
  mustDo(user, "change_prices");
  const detail = await createCredit((await params).id);
  return invoiceResponse(detail);
});
