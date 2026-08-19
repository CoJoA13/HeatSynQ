import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { HttpError } from "@/server/errors";
import { mustCan } from "@/server/permissions";
import { readAuditWithChildren, searchAudit } from "@/server/audit";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "admin", "view");
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity") ?? undefined;
  const entityId = url.searchParams.get("entityId") ?? undefined;
  // The single-record branch is the History panel's read, and since #153 it is a UNION over the
  // parent's child sections — a price edit or an address rename writes under its own entity, so an
  // exact match never showed it. It answers `{ rows, hasMore }` rather than a bare array because
  // the read is capped and the panel must be able to SAY so.
  //
  // The permission gate is unchanged and stays sufficient: `admin.view` already authorizes the
  // whole audit log (searchAudit below reads it unscoped), so the union exposes nothing a caller
  // could not already fetch by asking for each child id directly.
  if (entity && entityId) return NextResponse.json(await readAuditWithChildren(entity, entityId));

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
