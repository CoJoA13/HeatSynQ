import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { replaceShipperSerials } from "@/server/shippers";
import { shipperResponse } from "../../../../response";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "shipping", "edit");
  const { id, shipperOrderId } = await params;
  const detail = await replaceShipperSerials(id, shipperOrderId, await req.json());
  return shipperResponse(detail);
});
