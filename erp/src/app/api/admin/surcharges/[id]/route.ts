import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateSurcharge, deleteSurcharge } from "@/server/surcharges";

// `updateSurcharge` validates and persists the WHOLE row (surcharges.ts's `toSurchargeRow`
// normalize-on-write) — this route hands the body straight through rather than merging a
// partial patch, so the caller (the admin page) is the one responsible for always sending the
// complete row (task-7 brief).
export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "edit");
  const { id } = await params;
  await updateSurcharge(id, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "edit");
  await deleteSurcharge((await params).id);
  return NextResponse.json({ ok: true });
});
