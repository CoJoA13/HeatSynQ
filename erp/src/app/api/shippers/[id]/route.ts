import { NextResponse } from "next/server";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { getShipper, updateShipper, voidShipper } from "@/server/shippers";
import { shipperResponse } from "../response";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "shipping", "view");
  // Wrapped through `shipperResponse` (review round 2, 2026-08-04): the shipment page (spec §11)
  // remounts per id and renders §5.7's warnings as banners on a plain load, not only right after
  // an edit — an over-ship condition created in an earlier session must still show up the next
  // time this shipment is opened. `overshipWarnings` is a pure read over data `getShipper` already
  // fetched, so this costs no extra query. Client components can't import `src/server/**`, so a
  // downstream screen has no other seam to compute this itself without a second round trip.
  return shipperResponse(await getShipper((await params).id));
});

export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "shipping", "edit");
  const detail = await updateShipper((await params).id, await req.json());
  return shipperResponse(detail);
});

export const DELETE = handle(async (req, { params }) => {
  // Void (spec §5.6): gated on the SPECIAL action alone, the `void_order` shape — no
  // `shipping.*` CRUD permission substitutes for it.
  mustDo(requireUser(), "void_shipper");
  const body: unknown = await req.json().catch(() => null);
  await voidShipper((await params).id, reasonFromBody(body));
  return NextResponse.json({ ok: true });
});
