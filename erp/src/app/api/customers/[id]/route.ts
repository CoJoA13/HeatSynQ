import { NextResponse } from "next/server";
import { handle, requireUser, reasonFromBody } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getCustomer, updateCustomer, deleteCustomer } from "@/server/customers";

export const GET = handle(async (_req, { params }) => {
  mustCan(requireUser(), "customers", "view");
  return NextResponse.json(await getCustomer((await params).id));
});

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "edit");
  await updateCustomer((await params).id, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (req, { params }) => {
  mustCan(requireUser(), "customers", "delete");
  // A DELETE carrying a body — the reason spec §9 requires for a destructive action. A request
  // with no body at all, or a body that isn't a JSON object (e.g. `null`), is deliberately not a
  // parse error: the service reports the missing reason as a field-anchored 400 rather than this
  // route failing on malformed JSON.
  const body: unknown = await req.json().catch(() => null);
  await deleteCustomer((await params).id, reasonFromBody(body));
  return NextResponse.json({ ok: true });
});
