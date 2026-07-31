import { config, ZodError } from "zod";
import { en } from "zod/locales";

/**
 * zod 4's English locale (the source of specific messages like "Too small: expected string
 * to have >=1 characters") is registered by a top-level `config(en())` call inside zod's own
 * entry point (`zod/v4/classic/external`). That call's return value is unused, and zod's
 * package.json declares `"sideEffects": false`, so Next's bundler (webpack, for both `next
 * build` and `next dev`) treats the call — and the whole `locales/en` module it pulls in —
 * as dead code and drops it from the bundle. Every issue then falls back to core's generic
 * `"Invalid input"`. vitest runs source through esbuild/Vite without that dead-code pass, so
 * it never reproduces this: identical code, two different runtimes, two different strings.
 *
 * Verified by grepping the built server bundle: `.next/server/chunks/885.js` (production
 * build, `.next` cleared first) contains the zod error *codes* (`"too_small"`,
 * `"unrecognized_keys"`, etc.) but none of the English locale's literal message text
 * ("Unrecognized key", "expected string, received number", ...) — confirming `locales/en`
 * itself was tree-shaken out, not just unreachable at runtime.
 *
 * Re-registering the locale here — in a module that isn't itself marked side-effect-free —
 * keeps this call and its `locales/en` import in the bundle. `config()` writes to a
 * `globalThis` slot (`__zod_globalConfig`), so one registration anywhere in the process, made
 * before any issue's message is read, covers every zod call site in this realm; it does not
 * need to run per request. Module-level code runs at import time, before any exported
 * function executes, and every route goes through `handle()` in ./http.ts, which imports this
 * module — so this is guaranteed to run before any route's `.parse()` can throw.
 */
config(en());

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
