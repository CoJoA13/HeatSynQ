import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { allSettings, setSetting } from "@/server/settings";

export const GET = handle(async () => {
  mustCan(requireUser(), "admin", "view");
  return NextResponse.json(await allSettings());
});

export const PUT = handle(async (req) => {
  mustCan(requireUser(), "admin", "edit");
  const { key, value } = z.object({ key: z.string(), value: z.unknown() }).parse(await req.json());
  await setSetting(key, value);
  return NextResponse.json({ ok: true });
});
