import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listTemplates, createTemplate } from "@/server/templates";
import { TEMPLATE_DOC_TYPES } from "@/lib/template-contracts/index";

const DOC_TYPE = z.enum(TEMPLATE_DOC_TYPES);
const CREATE = z.object({ docType: DOC_TYPE, name: z.string().min(1).max(200) }).strict();

export const GET = handle(async (req) => {
  mustCan(requireUser(), "templates", "view");
  const raw = new URL(req.url).searchParams.get("docType");
  return NextResponse.json(await listTemplates(raw === null ? undefined : DOC_TYPE.parse(raw)));
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "templates", "create");
  const { docType, name } = CREATE.parse(await req.json());
  return NextResponse.json(await createTemplate(docType, name));
});
