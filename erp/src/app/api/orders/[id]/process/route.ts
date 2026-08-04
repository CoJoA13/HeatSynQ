import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getLockedRevision } from "@/server/orders";

/**
 * The order's locked recipe (spec §5.3/§11) — gated `orders.view` alone, not `processes.view`:
 * this is an order-scoped historical read (the recipe frozen onto the order at save time), not a
 * live parts-process one, and every caller who can view the order hub at all already holds
 * `orders.view`. Fix-wave R2 finding 7: `getLockedRevision` reads the order's own stored
 * (partId, revisionNumber) reference without gating on the part's current liveness, so this stays
 * 200 even for a voided order whose part has since been soft-deleted (legal once every order
 * referencing it is voided) — see orders.ts's own doc comment on the function.
 */
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "orders", "view");
  const { id } = await params;
  return NextResponse.json(await getLockedRevision(id));
});
