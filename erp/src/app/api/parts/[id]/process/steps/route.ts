import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { addStep } from "@/server/part-process-steps";

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "processes", "edit");
  return NextResponse.json(await addStep((await params).id, await req.json()));
});
