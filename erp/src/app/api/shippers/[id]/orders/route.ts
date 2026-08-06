import { handle, requireUser, HttpError, assertRecord } from "@/server/http";
import { mustCan, canDo } from "@/server/permissions";
import { addOrderToShipper } from "@/server/shippers";
import { shipperResponse } from "../../response";

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "shipping", "edit");
  const body: unknown = await req.json();
  assertRecord(body);
  // `addOrderToShipper` takes `orderId` as a plain string argument (no zod schema of its own to
  // report this), so the route is where a missing/malformed one becomes a field-anchored 400
  // instead of an HttpError-less TypeError escaping handle()'s mapping — the orders/[id]/link
  // precedent.
  const { orderId, creditHoldReason } = body;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new HttpError(400, "orderId is required");
  }
  // `canOverrideCreditHold` passed every time, true or false — the service (spec §5.4, extended
  // to shipment extension by the 2026-08-06 ruling) is what enforces the gate.
  const detail = await addOrderToShipper((await params).id, orderId,
    { canOverrideCreditHold: canDo(user, "override_credit_hold") },
    typeof creditHoldReason === "string" ? creditHoldReason : undefined);
  return shipperResponse(detail);
});
