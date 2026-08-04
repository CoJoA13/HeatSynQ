import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listViews, createView } from "@/server/saved-views";

// Gated on `orders.view` alone (design spec §9) — a saved view is a personal lens on the orders
// board, not its own CRUD area — with rows scoped to `user.id` (own rows only; the service
// enforces this structurally).

export const GET = handle(async () => {
  const user = requireUser();
  mustCan(user, "orders", "view");
  return NextResponse.json(await listViews(user.id));
});

export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "orders", "view");
  return NextResponse.json(await createView(user.id, await req.json()));
});
