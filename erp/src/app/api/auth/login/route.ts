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
  // A null here means the fence refused: the credential this login verified has already been
  // replaced by a concurrent password reset (#218 review P1) — the same generic 401 as a wrong
  // password, which is exactly what the old password now is.
  const session = await createSession(user.id, user.verifiedPasswordHash);
  if (!session) return NextResponse.json(INVALID_CREDENTIALS, { status: 401 });
  const { token } = session;
  const res = NextResponse.json({ ok: true, displayName: user.displayName });
  // #217: a browser-session cookie, deliberately — no `expires`. The cookie used to carry the
  // fixed expiresAt stamped at login, so the BROWSER deleted it session_timeout_minutes after
  // login regardless of activity while getSessionUser slid the DB row forward on every request:
  // the sliding expiry never reached the client and active users were logged out mid-shift.
  // With no client-side lifetime the server-side sliding expiry is the only clock. Accepted
  // residual: closing the browser within the timeout window drops the session where the old
  // cookie would have survived a restart — for an office app with an idle timeout, the safer
  // direction.
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return res;
});
