import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";

export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const rolePerms = user.role?.permissions.map((p) => p.permission) ?? [];
  const grants = user.overrides.filter((o) => o.mode === "GRANT").map((o) => o.permission);
  const denies = new Set(user.overrides.filter((o) => o.mode === "DENY").map((o) => o.permission));
  const effective = [...new Set([...rolePerms, ...grants])].filter((p) => !denies.has(p));
  return NextResponse.json({
    id: user.id, username: user.username, displayName: user.displayName, permissions: effective,
  });
});
