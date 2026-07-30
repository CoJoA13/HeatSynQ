import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { readAudit, searchAudit } from "@/server/audit";

export const GET = handle(async (req) => {
  mustCan(await requireUser(req), "admin", "view");
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity") ?? undefined;
  const entityId = url.searchParams.get("entityId") ?? undefined;
  if (entity && entityId) return NextResponse.json(await readAudit(entity, entityId));
  return NextResponse.json(await searchAudit({
    entity,
    actorName: url.searchParams.get("actor") ?? undefined,
    from: url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : undefined,
    to: url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : undefined,
  }));
});
