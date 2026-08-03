import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getAttachment, deleteAttachment, contentDisposition } from "@/server/attachments";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "view");
  const { id, attId } = await params;
  const att = await getAttachment("part", id, attId);
  return new NextResponse(new Uint8Array(att.fileData), {
    status: 200,
    headers: {
      "content-type": att.mimeType,
      "content-disposition": contentDisposition(att.mimeType, att.filename),
    },
  });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "parts", "edit");
  const { id, attId } = await params;
  await deleteAttachment("part", id, attId);
  return NextResponse.json({ ok: true });
});
