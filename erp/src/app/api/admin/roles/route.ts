import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listRoles, createRole } from "@/server/roles";

export const GET = handle(async () => {
  mustCan(requireUser(), "admin", "view");
  return NextResponse.json(await listRoles());
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "admin", "edit");
  const { name } = z.object({ name: z.string().min(1) }).parse(await req.json());
  return NextResponse.json(await createRole(name));
});
