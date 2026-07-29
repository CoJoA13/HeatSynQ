import { NextResponse } from "next/server";
import { getSessionUser } from "./sessions";
import { runWithActor } from "./context";

export const SESSION_COOKIE = "erp_session";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

export function cookieToken(req: Request): string | null {
  const header = req.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

export async function requireUser(req: Request): Promise<SessionUser> {
  const token = cookieToken(req);
  const user = token ? await getSessionUser(token) : null;
  if (!user) throw new HttpError(401, "Not signed in");
  return user;
}

type Handler = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<NextResponse>;

/** Wraps a route handler: catches HttpError, and if a session exists, runs inside the actor context. */
export function handle(fn: Handler): Handler {
  return async (req, ctx) => {
    const token = cookieToken(req);
    const user = token ? await getSessionUser(token) : null;
    const actor = user ? { id: user.id, name: user.displayName } : { id: null, name: "anonymous" };
    try {
      return await runWithActor(actor, () => fn(req, ctx));
    } catch (err) {
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  };
}
