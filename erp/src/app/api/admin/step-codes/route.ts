import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listStepCodes, createStepCode } from "@/server/process-step-codes";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "admin", "view");
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  return NextResponse.json(await listStepCodes({ includeInactive }));
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "admin", "create");
  return NextResponse.json(await createStepCode(await req.json()));
});
