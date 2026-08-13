import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getTemplateVersion } from "@/server/templates";

const VERSION_NUMBER = z.coerce.number().int().min(1);

// The one config-bearing version read (the history list is config-free — templates.ts's
// TemplateDetail): what the editor's "open draft from version N" preview reads.
export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "templates", "view");
  const { id, versionNumber } = await params;
  return NextResponse.json(await getTemplateVersion(id, VERSION_NUMBER.parse(versionNumber)));
});
