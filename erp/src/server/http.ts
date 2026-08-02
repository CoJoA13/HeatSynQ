import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getSessionUser, type SessionUser } from "./sessions";
import { runWithContext, currentUser } from "./context";
import { HttpError } from "./errors";
import { readableMessage } from "./error-message";

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

/**
 * Asserts a parsed JSON body is a plain record before a handler inspects its keys.
 * `await req.json()` happily returns any valid JSON value — `null`, a bare string/number, an
 * array — and `Object.keys`/the `in` operator throw a raw TypeError for `null` and non-object
 * primitives. That TypeError is neither a ZodError nor an HttpError, so it escapes `handle`'s
 * mapping below and surfaces as an unhandled 500 instead of a clean 400 (F8, PR #13 review).
 */
export function assertRecord(body: unknown): asserts body is Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
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
        return NextResponse.json({ error: readableMessage(err) }, { status: 400 });
      }
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  };
}
