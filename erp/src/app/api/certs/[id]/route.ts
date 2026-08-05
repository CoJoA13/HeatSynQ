import { NextResponse } from "next/server";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getCert, updateCert, voidCert } from "@/server/certs";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "certs", "view");
  return NextResponse.json(await getCert((await params).id));
});

export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "certs", "edit");
  return NextResponse.json(await updateCert((await params).id, await req.json()));
});

export const DELETE = handle(async (req, { params }) => {
  mustCan(requireUser(), "certs", "delete");
  // A DELETE carrying a body — the reason spec §9 requires for a destructive action. The
  // deletePart/deleteCustomer/voidOrder precedent: a missing or unparsable body is not a parse
  // error here, `voidCert`'s own missing-reason 400 is what a caller sees.
  const body: unknown = await req.json().catch(() => null);
  await voidCert((await params).id, reasonFromBody(body));
  return NextResponse.json({ ok: true });
});
