import { NextResponse } from "next/server";
import { handle, requireUser, assertRecord } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listParts, createPart } from "@/server/parts";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "parts", "view");
  const url = new URL(req.url);
  return NextResponse.json(await listParts({
    includeInactive: url.searchParams.get("includeInactive") === "1",
    search: url.searchParams.get("search") ?? undefined,
  }));
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "parts", "create");
  const body: unknown = await req.json();
  assertRecord(body);
  return NextResponse.json(await createPart(body));
});
