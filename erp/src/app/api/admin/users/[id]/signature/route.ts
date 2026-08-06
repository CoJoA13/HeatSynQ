import { NextResponse } from "next/server";
import { handle, requireUser, parseUploadFile, HttpError } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { setSignature, clearSignature, getSignature } from "@/server/users";

export const GET = handle(async (_req, { params }) => {
  mustDo(requireUser(), "manage_users");
  const { id } = await params;
  const signature = await getSignature(id);
  if (!signature) throw new HttpError(404, "No signature on file");
  return new NextResponse(new Uint8Array(signature.data), {
    status: 200,
    headers: { "content-type": signature.mimeType },
  });
});

export const PUT = handle(async (req, { params }) => {
  mustDo(requireUser(), "manage_users");
  const { id } = await params;
  const file = await parseUploadFile(req);
  await setSignature(id, file.data, file.mimeType);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustDo(requireUser(), "manage_users");
  const { id } = await params;
  await clearSignature(id);
  return NextResponse.json({ ok: true });
});
