import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { renameRole, setRolePermissions, deleteRole } from "@/server/roles";

const Body = z.object({ name: z.string().min(1).optional(), permissions: z.array(z.string()).optional() });

export const PUT = handle(async (req, ctx) => {
  mustCan(requireUser(), "admin", "edit");
  const { id } = await ctx.params;
  const body = Body.parse(await req.json());
  if (body.name) await renameRole(id, body.name);
  if (body.permissions) await setRolePermissions(id, body.permissions);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (req, ctx) => {
  mustCan(requireUser(), "admin", "delete");
  const { id } = await ctx.params;
  // A DELETE carrying a body — the reason a role delete now requires. A request with no body
  // at all is deliberately not a parse error: the service reports the missing reason as a
  // field-anchored 400 rather than this route failing on malformed JSON. Mirrors deleteCustomer's
  // route (src/app/api/customers/[id]/route.ts).
  const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
  await deleteRole(id, typeof body.reason === "string" ? body.reason : "");
  return NextResponse.json({ ok: true });
});
