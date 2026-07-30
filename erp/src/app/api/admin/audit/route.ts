import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { HttpError } from "@/server/errors";
import { mustCan } from "@/server/permissions";
import { readAudit, searchAudit } from "@/server/audit";

export const GET = handle(async (req) => {
  mustCan(await requireUser(req), "admin", "view");
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity") ?? undefined;
  const entityId = url.searchParams.get("entityId") ?? undefined;
  if (entity && entityId) return NextResponse.json(await readAudit(entity, entityId));

  let from: Date | undefined;
  if (url.searchParams.get("from")) {
    from = new Date(url.searchParams.get("from")!);
    if (Number.isNaN(from.getTime())) {
      throw new HttpError(400, "Invalid 'from' date");
    }
  }

  let to: Date | undefined;
  if (url.searchParams.get("to")) {
    to = new Date(url.searchParams.get("to")!);
    if (Number.isNaN(to.getTime())) {
      throw new HttpError(400, "Invalid 'to' date");
    }
  }

  return NextResponse.json(await searchAudit({
    entity,
    actorName: url.searchParams.get("actor") ?? undefined,
    from,
    to,
  }));
});
