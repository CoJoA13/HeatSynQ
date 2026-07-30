import { ZodError } from "zod";

/**
 * Turns a thrown error into the one-line, human-readable text a caller should show a user —
 * the same mapping `handle()` applies to route responses. Exists so code that catches errors
 * directly instead of letting them bubble to `handle()` (paste's per-row loop, which must keep
 * going after a bad row rather than let the whole request fail) doesn't need a second, drifting
 * copy of `ZodError`'s "$path: $message" translation.
 *
 * Split out from ./errors.ts rather than added there: errors.ts is deliberately import-free
 * (tests/errors.test.ts enforces it, to keep HttpError reachable without pulling in next/server
 * or Prisma), and `zod` is the one dependency this translation can't do without.
 */
export function readableMessage(err: unknown): string {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    return `${issue.path.join(".") || "body"}: ${issue.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
