import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { prisma } from "@/server/db";

/**
 * Session-gated read (spec §9, §5.15 vocabulary rule): no `mustCan` — every signed-in user can
 * see which step codes exist and what fields they carry, the same way any signed-in user can see
 * other pick-lists. Returns live codes only (`deletedAt: null`; inactive-but-live codes ARE
 * included, with `active: false`, so the UI can decide how to present them), each with its field
 * defs sorted by `sort`. No `.catch(() => {})` — a failed fetch reports, it doesn't go silent.
 */
export const GET = handle(async () => {
  // Session-gated only — no mustCan/mustDo (spec §5.15 vocabulary rule). The 401 comes from
  // the call itself; nothing about the caller beyond "has a session" matters here. Assigned
  // (not a bare call) so tests/permissions-sweep.test.ts's structural check — every genuine
  // requireUser() call either feeds mustCan/mustDo or binds a variable — still recognizes this
  // as authorizing, not a dead import.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const user = requireUser();
  const codes = await prisma.processStepCode.findMany({
    where: { deletedAt: null },
    orderBy: { code: "asc" },
    include: { fields: { orderBy: { sort: "asc" } } },
  });
  return NextResponse.json(codes.map((c) => ({
    id: c.id, code: c.code, name: c.name, active: c.active,
    fields: c.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, unit: f.unit, sort: f.sort })),
  })));
});
