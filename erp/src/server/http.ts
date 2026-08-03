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

/**
 * Reads a single `file` field out of a multipart form body — the shape every file-upload POST
 * route uses (currently both attachment owners, parts and orders; src/server/attachments.ts
 * stays free of any Request/FormData-shaped code the same way orders.ts/parts.ts stay free of
 * JSON-body parsing, which lives in the route handler instead). `req.formData()` itself only
 * throws for a body that isn't parseable as multipart at all — folded into the same 400 as a
 * well-formed body missing the field entirely, since both are equally "no file was sent" from the
 * caller's point of view.
 */
export async function parseUploadFile(req: Request): Promise<{ filename: string; mimeType: string; data: Buffer }> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "A file is required");
  }
  const entry = form.get("file");
  if (!(entry instanceof Blob)) throw new HttpError(400, "A file is required");
  // A plain Blob (no filename given to FormData.set/append) still satisfies the Blob check above,
  // but only a File carries `.name` — the multipart spec itself defaults a nameless Blob entry to
  // a File named "blob" (WHATWG FormData §mutation), so this branch is a defensive fallback, not
  // the expected path for a real browser upload or this repo's own test helper.
  const filename = entry instanceof File ? entry.name : "upload";
  return { filename, mimeType: entry.type, data: Buffer.from(await entry.arrayBuffer()) };
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
