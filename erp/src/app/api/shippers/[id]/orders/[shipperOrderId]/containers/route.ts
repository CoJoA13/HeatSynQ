import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { replaceShipperContainers } from "@/server/shippers";
import { shipperResponse } from "../../../../response";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "shipping", "edit");
  const { id, shipperOrderId } = await params;
  const detail = await replaceShipperContainers(id, shipperOrderId, await req.json());
  return shipperResponse(detail);
});
