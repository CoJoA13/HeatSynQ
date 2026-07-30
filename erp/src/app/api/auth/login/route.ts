import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateUser } from "@/server/auth";
import { createSession } from "@/server/sessions";
import { SESSION_COOKIE, handle } from "@/server/http";

const Body = z.object({ username: z.string().min(1), password: z.string().min(1) });

const INVALID_CREDENTIALS = { error: "Invalid username or password" } as const;

export const POST = handle(async (req) => {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(INVALID_CREDENTIALS, { status: 401 });
  }
  const body = Body.safeParse(json);
  if (!body.success) return NextResponse.json(INVALID_CREDENTIALS, { status: 401 });
  const user = await authenticateUser(body.data.username, body.data.password);
  if (!user) return NextResponse.json(INVALID_CREDENTIALS, { status: 401 });
  const { token, expiresAt } = await createSession(user.id);
  const res = NextResponse.json({ ok: true, displayName: user.displayName });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  return res;
});
