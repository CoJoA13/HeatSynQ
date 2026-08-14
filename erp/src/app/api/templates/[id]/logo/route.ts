import { NextResponse } from "next/server";
import { handle, requireUser, parseUploadFile } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { uploadLogo, clearLogo } from "@/server/templates";

// The signature-route shape (#49): parseUploadFile bounds and parses the multipart body; the
// service owns the MIME allowlist, the 512KB cap, and the magic-byte sniff.
export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "templates", "edit");
  const { id } = await params;
  const file = await parseUploadFile(req);
  await uploadLogo(id, file.data, file.mimeType);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "templates", "edit");
  const { id } = await params;
  await clearLogo(id);
  return NextResponse.json({ ok: true });
});
