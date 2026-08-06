import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { shipmentsForOrder } from "@/server/shippers";

/** Every shipment that has ever carried this order, voided included — the order hub's own
 *  Shipments section (design spec §11). */
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "shipping", "view");
  return NextResponse.json(await shipmentsForOrder((await params).id));
});
