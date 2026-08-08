import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { createCredit } from "@/server/invoices";
import { invoiceResponse } from "../../response";

// POST /api/invoices/[id]/credit — raises a DRAFT credit against a finalized invoice. §5.6: "Its
// lifecycle is the invoice's; its permissions are the invoice's." Raising an invoice needs
// `invoicing.create` alone (§5.5) — the amounts are derived from prices, not user-set — and a
// credit's lines are likewise derived (copied from the finalized source with the sign flipped),
// so raising a credit gates exactly like raising an invoice: `invoicing.create` alone.
// `change_prices` gates editing money on existing lines (the `.../lines` and `.../recalculate`
// routes), which a credit reaches later through those same routes, already gated there. Calls the
// no-`tx` `createCredit(id)` form — there is no `tx`-taking overload on this one, only the wrapped
// bracket.
export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "invoicing", "create");
  const detail = await createCredit((await params).id);
  return invoiceResponse(detail);
});
