import { NextResponse } from "next/server";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { getShipper, updateShipper, voidShipper } from "@/server/shippers";
import { shipperResponse } from "../response";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "shipping", "view");
  return NextResponse.json(await getShipper((await params).id));
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
