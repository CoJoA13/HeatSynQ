import { NextResponse } from "next/server";
import { handle, requireUser, parseUploadFile } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listAttachments, addAttachment } from "@/server/attachments";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "orders", "view");
  return NextResponse.json(await listAttachments("order", (await params).id));
});

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "orders", "edit");
  const file = await parseUploadFile(req);
  return NextResponse.json(await addAttachment("order", (await params).id, file));
});
