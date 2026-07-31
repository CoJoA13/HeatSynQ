import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { ALL_PERMISSIONS, can, canDo, AREAS, CRUD_ACTIONS, SPECIAL_ACTIONS } from "@/server/permissions";

export const GET = handle(async () => {
  const user = requireUser();
  const permissions = ALL_PERMISSIONS.filter((key) => {
    const [head, tail] = key.split(".");
    return head === "action"
      ? canDo(user, tail as (typeof SPECIAL_ACTIONS)[number])
      : can(user, head as (typeof AREAS)[number], tail as (typeof CRUD_ACTIONS)[number]);
  });
  return NextResponse.json({
    id: user.id, username: user.username, displayName: user.displayName, permissions,
  });
});
