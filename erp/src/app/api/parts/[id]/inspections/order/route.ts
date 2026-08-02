import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reorderPartInspections } from "@/server/part-inspections";

const REORDER = z.object({ orderedIds: z.array(z.string().min(1)).min(1) }).strict();

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "parts", "edit");
  const { orderedIds } = REORDER.parse(await req.json());
  await reorderPartInspections((await params).id, orderedIds);
  return NextResponse.json({ ok: true });
});
