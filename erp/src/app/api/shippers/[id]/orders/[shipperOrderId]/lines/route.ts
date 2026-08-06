import { handle, requireUser } from "@/server/http";
import { mustCan, canDo } from "@/server/permissions";
import { replaceShipperLines } from "@/server/shippers";
import { shipperResponse } from "../../../../response";

export const PUT = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "shipping", "edit");
  const { id, shipperOrderId } = await params;
  // `canOverrideCreditHold` passed every time, true or false — the service (spec §5.4, extended
  // to shipment extension by the 2026-08-06 ruling) is what enforces the gate.
  const detail = await replaceShipperLines(id, shipperOrderId, await req.json(),
    { canOverrideCreditHold: canDo(user, "override_credit_hold") });
  return shipperResponse(detail);
});
