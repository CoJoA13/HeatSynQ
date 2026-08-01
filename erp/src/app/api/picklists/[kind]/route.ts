import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { HttpError } from "@/server/errors";
import { prisma } from "@/server/db";
import { PICKLIST_KINDS, type PickListKind } from "@/lib/reference-constants";

/** Read-only, gated on a session alone. Reference names are vocabulary, not secrets — materials
 *  and specifications are the language of the paperwork customers already receive. Create/edit/
 *  delete stay under `admin` on /api/admin/reference/*. A 13th permission area was considered
 *  and rejected: it would relocate the silent-empty-dropdown failure to a role misconfiguration
 *  instead of removing it. */
export const GET = handle(async (req, { params }) => {
  const user = requireUser();
  void user; // Session-only gate: presence of a signed-in user is the whole check, no permission
  // beyond that. Bound to a variable (not a bare `requireUser();`) because
  // tests/permissions-sweep.test.ts's "every API route calls requireUser" check requires the
  // call to feed mustCan/mustDo or be assigned — a discarded bare call is indistinguishable
  // from a route that imports requireUser but never actually calls it.
  const { kind } = await params;
  if (!(PICKLIST_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(404, `Unknown pick list: ${kind}`);
  }
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  const where = { deletedAt: null, ...(includeInactive ? {} : { active: true }) };

  if (kind === "processStepCode") {
    const rows = await prisma.processStepCode.findMany({
      where, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, active: true },
    });
    // Narrow projection on purpose: the GL account these carry never crosses this route.
    return NextResponse.json(rows.map((r) => ({ id: r.id, name: `${r.code} — ${r.name}`, active: r.active })));
  }

  const delegate = prisma[kind as Exclude<PickListKind, "processStepCode">] as unknown as {
    findMany: (a: object) => Promise<{ id: string; name: string; active: boolean }[]>;
  };
  return NextResponse.json(await delegate.findMany({
    where, orderBy: { name: "asc" }, select: { id: true, name: true, active: true },
  }));
});
