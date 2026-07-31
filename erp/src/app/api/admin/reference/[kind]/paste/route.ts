import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { pasteReference } from "@/server/paste";

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "create");
  const { kind } = await params;
  const { text } = z.object({ text: z.string().min(1).max(200_000) }).parse(await req.json());
  return NextResponse.json(await pasteReference(kind, text));
});
