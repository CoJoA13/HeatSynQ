import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { renameRole, setRolePermissions, deleteRole } from "@/server/roles";

const Body = z.object({ name: z.string().min(1).optional(), permissions: z.array(z.string()).optional() });

export const PUT = handle(async (req, ctx) => {
  mustCan(await requireUser(req), "admin", "edit");
  const { id } = await ctx!.params; // Next.js always supplies ctx for dynamic routes
  const body = Body.parse(await req.json());
  if (body.name) await renameRole(id, body.name);
  if (body.permissions) await setRolePermissions(id, body.permissions);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (req, ctx) => {
  mustCan(await requireUser(req), "admin", "edit");
  const { id } = await ctx!.params; // Next.js always supplies ctx for dynamic routes
  await deleteRole(id);
  return NextResponse.json({ ok: true });
});
