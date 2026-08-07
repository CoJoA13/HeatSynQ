import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { reverseShipper } from "@/server/shippers";
import { shipperResponse } from "../../response";

// POST /api/shippers/[id]/reverse — the reversing shipment (spec §5.6). Gated on the SPECIAL action
// alone, the void_shipper shape (a reversal is the correction for an already-invoiced order that a
// void cannot touch, so it shares void's permission — no shipping.* CRUD grant substitutes for it).
// Body: { reason, shipDate? }. Wrapped through `shipperResponse` so the reversal's §5.7 warning
// surface rides the response exactly like every other shipment mutation.
export const POST = handle(async (req, { params }) => {
  mustDo(requireUser(), "void_shipper");
  const body: unknown = await req.json().catch(() => ({}));
  const { shipper } = await reverseShipper((await params).id, body);
  return shipperResponse(shipper);
});
