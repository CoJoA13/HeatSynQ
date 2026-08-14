import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { openDraft, editDraft, discardDraft } from "@/server/templates";

// POST body is optional — a bare open takes the default source (the current published version);
// `fromVersion` is the §5.1 revert flow. A missing body parses as {}.
const OPEN = z.object({ fromVersion: z.number().int().min(1).optional() }).strict();
// `config` is a loose object here: the SERVICE validates it against the docType's contract
// (shape → ZodError, rule → the named 400) — the route only refuses non-objects early.
const EDIT = z.object({ config: z.looseObject({}), updatedAt: z.coerce.date() }).strict();

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "templates", "edit");
  const { id } = await params;
  const { fromVersion } = OPEN.parse(await req.json().catch(() => ({})));
  return NextResponse.json(await openDraft(id, { fromVersion }));
});

export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "templates", "edit");
  const { id } = await params;
  const { config, updatedAt } = EDIT.parse(await req.json());
  return NextResponse.json(await editDraft(id, { config, updatedAt }));
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "templates", "edit");
  const { id } = await params;
  await discardDraft(id);
  return NextResponse.json({ ok: true });
});
