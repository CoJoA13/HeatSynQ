import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { globalSearch } from "@/server/search";

// `requireUser` only — no area permission gate on the route itself. `globalSearch` does its own
// per-group filtering against the caller's `*.view` grants (search.ts), so the route's job is
// just to hand it the REAL SessionUser from the session, not a reconstruction of it.

export const GET = handle(async (req) => {
  const user = requireUser();
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return NextResponse.json(await globalSearch(user, q));
});
