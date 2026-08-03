import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateView, deleteView } from "@/server/saved-views";

// Same single gate as the collection route: `orders.view` + own rows. `updateView`/`deleteView`
// key their lookup on `(id, userId)` together, so a wrong-owner id and a missing id are
// structurally indistinguishable — both come back 404, never a 403 that would leak the row's
// existence to someone who merely doesn't own it.

export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "orders", "view");
  return NextResponse.json(await updateView(user.id, (await params).id, await req.json()));
});

export const DELETE = handle(async (_req, { params }) => {
  const user = requireUser();
  mustCan(user, "orders", "view");
  // No reason required (spec §5.17's classification): this frees a name only inside the
  // caller's own private namespace, so unlike voidOrder/deletePart there is no reasonFromBody
  // here — deleteView takes no reason argument at all.
  await deleteView(user.id, (await params).id);
  return NextResponse.json({ ok: true });
});
