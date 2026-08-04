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
 * The largest multipart body `parseUploadFile` will let through to `req.formData()`. Deliberately
 * ABOVE attachments.ts's own 20 MB `MAX_SIZE`: the declared length covers the whole multipart
 * envelope (boundaries, per-part headers, the filename), not just the file's bytes, so a
 * legitimate 20 MB file always arrives declaring somewhat more than 20 MB. This is the coarse
 * pre-parse bound; the exact per-file cap stays where it belongs, on `file.data.byteLength`.
 */
const MAX_UPLOAD_BODY = 21_000_000;

/**
 * Refuses an upload whose body is too large — or whose size cannot be established — BEFORE
 * anything reads it.
 *
 * Fix-wave R4 finding 1: the 20 MB cap was enforced only in `addAttachment`, on the already-
 * materialized `file.data.byteLength`. By the time that check ran, `req.formData()` had buffered
 * the ENTIRE request body into memory, so the cap bounded what could be STORED while leaving what
 * could be ALLOCATED unbounded — a single POST with a multi-gigabyte body was a trivially
 * exploitable memory exhaustion, no permissions or valid file needed beyond reaching the route.
 *
 * `Content-Length` is a claim by the client, not a proof, so this is a cheap first gate rather
 * than the whole answer: a client that under-declares still gets through here and is caught by
 * the real byte-length cap afterwards — which is exactly the case that still buffers, and exactly
 * what backlog issue #38 (streaming enforcement, counting bytes as they arrive and aborting mid-
 * stream) remains open to close. What this closes is the trivial case: an HONEST declaration of
 * an oversized body, and an UNDECLARED one, are both refused for the cost of a header read.
 *
 * An absent or malformed `Content-Length` is refused too, not waved through: without it there is
 * no bound to check at all, and "buffer it and see" is the very thing being prevented. Every
 * browser sets it on a multipart POST (the body is fully known before the request is sent), so
 * this costs the real client nothing; a chunked-encoding uploader is refused with a message that
 * says which header is missing rather than failing mysteriously.
 */
export function assertDeclaredUploadSize(req: Request): void {
  const declared = req.headers.get("content-length");
  // Strict digits-only: `Number("")` is 0 and `Number("0x10")` is 16, either of which would let a
  // meaningless header stand in for a real declaration.
  if (declared === null || !/^\d+$/.test(declared.trim())) {
    throw new HttpError(400, "Uploads must declare their size with a Content-Length header");
  }
  if (Number(declared.trim()) > MAX_UPLOAD_BODY) throw new HttpError(413, "Uploads are limited to 20 MB");
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
  assertDeclaredUploadSize(req);
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
