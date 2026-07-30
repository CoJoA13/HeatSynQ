import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { listUsers, createUser } from "@/server/users";

export const GET = handle(async () => {
  mustDo(requireUser(), "manage_users");
  return NextResponse.json(await listUsers());
});

const CreateBody = z.object({
  username: z.string().min(1),
  displayName: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters"),
  roleId: z.string().optional(),
});

export const POST = handle(async (req) => {
  mustDo(requireUser(), "manage_users");
  return NextResponse.json(await createUser(CreateBody.parse(await req.json())));
});
