import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getTemplate, renameTemplate, deleteTemplate } from "@/server/templates";

const RENAME = z.object({ name: z.string().min(1).max(200) }).strict();

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "templates", "view");
  const { id } = await params;
  return NextResponse.json(await getTemplate(id));
});

export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "templates", "edit");
  const { id } = await params;
  const { name } = RENAME.parse(await req.json());
  await renameTemplate(id, name);
  return NextResponse.json({ ok: true });
});

// Reasoned delete (§5.17) — the body tolerance is reasonFromBody's (a missing/unparsable body
// becomes "", and the service's own missing-reason 400 is what the caller sees).
export const DELETE = handle(async (req, { params }) => {
  mustCan(requireUser(), "templates", "delete");
  const { id } = await params;
  const reason = reasonFromBody(await req.json().catch(() => null));
  await deleteTemplate(id, reason);
  return NextResponse.json({ ok: true });
});
