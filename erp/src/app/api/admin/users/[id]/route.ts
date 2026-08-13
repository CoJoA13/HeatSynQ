import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { updateUser, setUserOverrides } from "@/server/users";

const Body = z.object({
  displayName: z.string().min(1).optional(),
  // The signature title (Phase 6 ruling 14) — blank is legal and clears it (blank prints nothing).
  title: z.string().max(200).optional(),
  roleId: z.string().nullable().optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).optional(),
  overrides: z.array(z.object({ permission: z.string(), mode: z.enum(["GRANT", "DENY"]) })).optional(),
});

export const PUT = handle(async (req, ctx) => {
  mustDo(requireUser(), "manage_users");
  const { id } = await ctx.params;
  const body = Body.parse(await req.json());
  const { overrides, ...rest } = body;
  if (Object.keys(rest).length) await updateUser(id, rest);
  if (overrides) await setUserOverrides(id, overrides);
  return NextResponse.json({ ok: true });
});
