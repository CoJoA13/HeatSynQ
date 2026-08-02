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

/**
 * Pulls an optional string `reason` out of a DELETE body, tolerating any parsed JSON shape.
 * A DELETE route's own body handling deliberately swallows a missing/unparsable body into
 * `null` (`req.json().catch(() => null)`) rather than treating it as a parse error — the
 * service's own missing-reason 400 is meant to be what a caller sees. But `null` is valid JSON,
 * and `null.reason` throws a raw TypeError that escapes `handle`'s error mapping as an
 * unhandled 500 instead (G2, PR #13 round 2 review). This normalizes instead of asserting: any
 * non-record body (`null`, an array, a bare string/number) — and any record whose `reason` isn't
 * a string — becomes `""`, which the service reports as its normal missing-reason 400.
 */
export function reasonFromBody(body: unknown): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "";
  const reason = (body as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : "";
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
