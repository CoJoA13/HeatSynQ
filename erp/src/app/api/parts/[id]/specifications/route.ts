import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listPartSpecs, addPartSpec } from "@/server/part-specifications";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "view");
  return NextResponse.json(await listPartSpecs((await params).id));
});

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "parts", "edit");
  const { specificationId } = z.object({ specificationId: z.string().min(1) }).parse(await req.json());
  return NextResponse.json(await addPartSpec((await params).id, specificationId));
});
