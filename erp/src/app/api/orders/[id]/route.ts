import { NextResponse } from "next/server";
import { handle, requireUser, HttpError, assertRecord, reasonFromBody } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { getOrder, updateOrder, voidOrder } from "@/server/orders";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "orders", "view");
  return NextResponse.json(await getOrder((await params).id));
});

export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  const body: unknown = await req.json();
  assertRecord(body);
  // An empty body changes nothing — report that as an error rather than a no-op 200
  // (parts/[id]/route.ts precedent).
  if (Object.keys(body).length === 0) {
    throw new HttpError(400, "PATCH body must include at least one change");
  }
  return NextResponse.json(await updateOrder((await params).id, body));
});

export const DELETE = handle(async (req, { params }) => {
  // Void (spec §5c): gated on the SPECIAL action alone. No orders.* CRUD permission substitutes
  // for it — a user holding orders.view/create/edit together still needs action.void_order.
  mustDo(requireUser(), "void_order");
  // A DELETE carrying a body — the reason spec §9 requires for a destructive action. A request
  // with no body at all, or a body that isn't a JSON object (e.g. `null`), is deliberately not a
  // parse error: the service reports the missing reason as a field-anchored 400 rather than this
  // route failing on malformed JSON. Mirrors deletePart's / deleteCustomer's route.
  const body: unknown = await req.json().catch(() => null);
  await voidOrder((await params).id, reasonFromBody(body));
  return NextResponse.json({ ok: true });
});
