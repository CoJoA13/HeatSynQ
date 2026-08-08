import { NextResponse } from "next/server";
import { handle, requireUser, assertRecord } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { getBillingConfig, setBillingConfig } from "@/server/billing-config";

export const GET = handle(async () => {
  mustCan(requireUser(), "admin", "view");
  return NextResponse.json(await getBillingConfig());
});

export const PUT = handle(async (req) => {
  mustCan(requireUser(), "admin", "edit");
  const body = await req.json();
  assertRecord(body);
  return NextResponse.json(await setBillingConfig(body));
});
