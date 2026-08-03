import { NextResponse } from "next/server";
import { handle, requireUser, parseUploadFile } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listAttachments, addAttachment } from "@/server/attachments";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "view");
  return NextResponse.json(await listAttachments("part", (await params).id));
});

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "parts", "edit");
  const file = await parseUploadFile(req);
  return NextResponse.json(await addAttachment("part", (await params).id, file));
});
