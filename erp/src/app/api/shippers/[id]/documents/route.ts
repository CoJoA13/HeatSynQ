import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listDocumentsForShipper } from "@/server/documents";

/**
 * Every `SHIPPER`/`BOL` document filed against this shipment — metadata only, never the bytes
 * (design spec §11's shipment page: "stored documents list"). No cross-kind union to filter, the
 * way `GET /api/orders/[id]/documents` needs one for a `TRAVELER`/`CERT` it might not be able to
 * show a caller: both kinds `listDocumentsForShipper` can ever return already sit behind the SAME
 * `shipping` area this route itself gates on, so nothing here can leak a kind the caller couldn't
 * already see by holding `shipping.view` in the first place.
 *
 * This route did not exist before Task 14 — `documents.ts`'s own `listDocumentsForShipper`
 * (Task 3) had no HTTP caller yet. Added here, mirroring `src/app/api/orders/[id]/documents/
 * route.ts` exactly, because the shipment page's stored-documents list has nothing else to call.
 */
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "shipping", "view");
  return NextResponse.json(await listDocumentsForShipper((await params).id));
});
