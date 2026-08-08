import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { recalculateInvoice } from "@/server/invoices";
import { invoiceResponse } from "../../response";

// POST /api/invoices/[id]/recalculate — re-prices from current data and replaces every derived
// line (§5.5). This changes line money exactly like a line replace does, so it carries the same
// `invoicing.edit` + `change_prices` gate (task-16-brief.md's binding requirement, carried in
// from Task 12's review — recalculate falls squarely under §5.5's "any edit that changes money on
// a line additionally needs change_prices").
export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "invoicing", "edit");
  mustDo(user, "change_prices");
  const detail = await recalculateInvoice((await params).id);
  return invoiceResponse(detail);
});
