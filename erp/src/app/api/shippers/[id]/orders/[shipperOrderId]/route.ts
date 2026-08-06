import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { removeOrderFromShipper } from "@/server/shippers";
import { shipperResponse } from "../../../response";

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "shipping", "edit");
  const { id, shipperOrderId } = await params;
  const detail = await removeOrderFromShipper(id, shipperOrderId);
  return shipperResponse(detail);
});
