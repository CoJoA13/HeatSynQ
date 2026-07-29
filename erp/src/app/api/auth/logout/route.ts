import { NextResponse } from "next/server";
import { destroySession } from "@/server/sessions";
import { SESSION_COOKIE, cookieToken, handle } from "@/server/http";

export const POST = handle(async (req) => {
  const token = cookieToken(req);
  if (token) await destroySession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
});
