import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { verifyPassword } from "@/server/password";
import { createSession } from "@/server/sessions";
import { SESSION_COOKIE, handle } from "@/server/http";

const Body = z.object({ username: z.string().min(1), password: z.string().min(1) });

export const POST = handle(async (req) => {
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { username: body.data.username } });
  const ok = user && user.active && !user.deletedAt && (await verifyPassword(user.passwordHash, body.data.password));
  if (!ok) return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
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
