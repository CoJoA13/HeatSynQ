import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { listAssignments, assignTemplate, clearAssignment } from "@/server/template-assignments";
import { TEMPLATE_DOC_TYPES } from "@/lib/template-contracts/index";

const DOC_TYPE = z.enum(TEMPLATE_DOC_TYPES);
const ASSIGN = z.object({ docType: DOC_TYPE, templateId: z.string().min(1) }).strict();

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  return NextResponse.json(await listAssignments((await params).id));
});

// Assigning changes what future paper looks like — customers-area edit AND the `edit_templates`
// special (spec §7, the change_prices pattern; publish and set-default carry the same pair).
export const PUT = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "customers", "edit");
  mustDo(user, "edit_templates");
  const { docType, templateId } = ASSIGN.parse(await req.json());
  return NextResponse.json(await assignTemplate((await params).id, docType, templateId));
});

// Same gates as PUT — clearing changes future paper too (it falls back down the §5.2 chain).
// No reason in the payload: §5.17 classifies clearing as reason-free (spec §7).
export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  mustCan(user, "customers", "edit");
  mustDo(user, "edit_templates");
  const docType = DOC_TYPE.parse(new URL(req.url).searchParams.get("docType"));
  await clearAssignment((await params).id, docType);
  return NextResponse.json({ ok: true });
});
