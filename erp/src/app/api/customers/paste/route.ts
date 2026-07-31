import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { pasteCustomers } from "@/server/customers";

export const POST = handle(async (req) => {
  mustCan(requireUser(), "customers", "create");
  const { text } = z.object({ text: z.string().min(1).max(200_000) }).parse(await req.json());
  return NextResponse.json(await pasteCustomers(text));
});
