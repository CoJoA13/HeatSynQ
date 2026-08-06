import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listDocuments } from "@/server/traveler";

/**
 * Every document filed against this order, newest first — metadata only, never the bytes. Voided
 * orders keep theirs listed (spec §5c: reads work on a voided order).
 *
 * Gated on `orders.view`, but that alone does not mean every KIND of document on the order is
 * this caller's to see: with Task 3's order-hub union, this list can include a shipment's BOL or
 * a certification that belongs to areas (`shipping`, `certs`) the caller may hold no permission
 * for at all. Owner ruling 2026-08-04 (Task 3 review round 2): the list must show only the kinds
 * the viewer may actually open, so the session `user` is passed through to `listDocuments`
 * (`listDocumentsForOrder`, documents.ts), which drops any kind `user` cannot view — the same
 * per-group filtering shape `globalSearch` (search.ts) already uses, rather than a second bespoke
 * mechanism.
 */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "orders", "view");
  const { id } = await params;
  return NextResponse.json(await listDocuments(id, user));
});
