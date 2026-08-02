import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { listPartBreaks, addPartBreak } from "@/server/part-price-breaks";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "view");
  return NextResponse.json(await listPartBreaks((await params).id));
});

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "parts", "edit");
  // Price breaks are pricing, unconditionally — no key-presence check like the part's own
  // pricing fields, unlike /api/parts and /api/parts/[id].
  mustDo(user, "change_prices");
  return NextResponse.json(await addPartBreak((await params).id, await req.json()));
});
