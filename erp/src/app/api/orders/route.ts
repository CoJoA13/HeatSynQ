import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { createOrder, listOrders } from "@/server/orders";
import { parseOrderFilter } from "./query";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "orders", "view");
  return NextResponse.json(await listOrders(parseOrderFilter(new URL(req.url))));
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "orders", "create");
  return NextResponse.json(await createOrder(await req.json()));
});
