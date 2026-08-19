import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser, reasonFromBody } from "@/server/http";
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
  // A DELETE carrying a body — the reason a role delete requires (spec §9; `deleteRole` enforces
  // it in the service). A request with no body at all, or a body that isn't a JSON object (e.g.
  // `null`), is deliberately not a parse error: the service reports the missing reason as a
  // field-anchored 400 rather than this route failing on malformed JSON. `reasonFromBody`'s own
  // docblock (http.ts) is the record of why the hand-rolled read this replaced was wrong — a JSON
  // body of literal `null` threw a raw TypeError out of the handler as a 500.
  const body: unknown = await req.json().catch(() => null);
  await deleteRole(id, reasonFromBody(body));
  return NextResponse.json({ ok: true });
});
