import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getSessionUser, type SessionUser } from "./sessions";
import { runWithContext, currentUser } from "./context";
import { HttpError } from "./errors";

export { HttpError };
export type { SessionUser };
export const SESSION_COOKIE = "erp_session";

export function cookieToken(req: Request): string | null {
  const header = req.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

export function requireUser(): SessionUser {
  const user = currentUser();
  if (!user) throw new HttpError(401, "Not signed in");
  return user;
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<NextResponse>;

/** Resolves the session ONCE, publishes it on the request context, and maps errors to JSON. */
export function handle(fn: Handler): Handler {
  return async (req, ctx) => {
    const token = cookieToken(req);
    const user = token ? await getSessionUser(token) : null;
    const actor = user ? { id: user.id, name: user.displayName } : { id: null, name: "anonymous" };
    try {
      return await runWithContext({ actor, user }, () => fn(req, ctx));
    } catch (err) {
      if (err instanceof ZodError) {
        const issue = err.issues[0];
        const message = `${issue.path.join(".") || "body"}: ${issue.message}`;
        return NextResponse.json({ error: message }, { status: 400 });
      }
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  };
}
