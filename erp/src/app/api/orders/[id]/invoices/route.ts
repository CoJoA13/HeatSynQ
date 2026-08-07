import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { invoicesForOrder } from "@/server/invoices";

/** Every invoice/credit ever raised against this order, discarded drafts included — the order
 *  hub's own Invoices section (design spec §11), the `shipmentsForOrder` route's own precedent. */
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "invoicing", "view");
  return NextResponse.json(await invoicesForOrder((await params).id));
});
