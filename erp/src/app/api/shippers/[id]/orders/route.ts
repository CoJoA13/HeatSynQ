import { handle, requireUser, HttpError, assertRecord } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { addOrderToShipper } from "@/server/shippers";
import { shipperResponse } from "../../response";

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "shipping", "edit");
  const body: unknown = await req.json();
  assertRecord(body);
  // `addOrderToShipper` takes `orderId` as a plain string argument (no zod schema of its own to
  // report this), so the route is where a missing/malformed one becomes a field-anchored 400
  // instead of an HttpError-less TypeError escaping handle()'s mapping — the orders/[id]/link
  // precedent.
  const { orderId } = body;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new HttpError(400, "orderId is required");
  }
  const detail = await addOrderToShipper((await params).id, orderId);
  return shipperResponse(detail);
});
