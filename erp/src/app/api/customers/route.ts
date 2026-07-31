import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listCustomers, createCustomer } from "@/server/customers";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "customers", "view");
  const url = new URL(req.url);
  return NextResponse.json(await listCustomers({
    includeInactive: url.searchParams.get("includeInactive") === "1",
    search: url.searchParams.get("search") ?? undefined,
  }));
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "customers", "create");
  return NextResponse.json(await createCustomer(await req.json()));
});
