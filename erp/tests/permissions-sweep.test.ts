import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every route handler must authorize. A new route that forgets fails here, not in production. */
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

/** Every *.ts file under src, so a resurrected exception is caught even if no test targets it. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [full] : [];
  });
}

// A bare `.includes("requireUser")` matches the import line even when the call itself is
// never made (or is replaced by a fabricated user object) — proven by editing a route to keep
// the import but drop the call, which the old check let through silently. Requiring the actual
// invocation `requireUser()` closes that. Going further: every genuine call site in this
// codebase either feeds the result straight into `mustCan(...)`/`mustDo(...)` or binds it to a
// variable (`const user = requireUser()`), so require one of those two shapes rather than a
// bare, result-discarding `requireUser();` — cheap extra signal, not just "the token appears
// somewhere in the file". `\s*` (which matches newlines) keeps this from breaking if the call
// wraps across lines; it does not require any of it to be on one line.
const CALLS_REQUIRE_USER = /\b(?:mustCan|mustDo)\s*\(\s*requireUser\(\)|=\s*requireUser\(\)/;

// Same class of gap as above: a bare `.includes("mustCan")` matches an unused import. Require
// the actual call.
const CALLS_PERMISSION_GATE = /\b(?:mustCan|mustDo)\s*\(/;

describe("permission sweep", () => {
  it("every API route calls requireUser", () => {
    const offenders = routeFiles(join(process.cwd(), "src/app/api"))
      .filter((f) => !CALLS_REQUIRE_USER.test(readFileSync(f, "utf8")))
      // The health probe and login are deliberately public. So is logout: it must clear a
      // stale cookie even when the session behind it has already expired or is invalid, so
      // gating it on requireUser would leave that cookie stuck client-side on a 401 instead
      // of being cleared — the same "must work without a prior valid session" reasoning that
      // exempts login.
      .filter((f) => !f.includes("api/health") && !f.includes("api/auth/login") && !f.includes("api/auth/logout"));
    expect(offenders).toEqual([]);
  });

  it("every admin route gates on a permission", () => {
    const offenders = routeFiles(join(process.cwd(), "src/app/api/admin"))
      .filter((f) => !CALLS_PERMISSION_GATE.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no client component imports from src/server", () => {
    function tsx(dir: string): string[] {
      return readdirSync(dir).flatMap((e) => {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) return tsx(full);
        return e.endsWith(".tsx") ? [full] : [];
      });
    }
    const offenders = [...tsx(join(process.cwd(), "src/components")), ...tsx(join(process.cwd(), "src/app"))]
      .filter((f) => { const s = readFileSync(f, "utf8"); return s.includes('"use client"') && /from "@\/server\//.test(s); });
    expect(offenders).toEqual([]);
  });

  // Task 4 retired settings.ts's documented exception to writing prisma.auditLog.create
  // directly; audit.ts is now the sole writer. This keeps that invariant from quietly
  // regressing — a new caller bypassing audit.ts would fail here, not in a missed audit trail.
  it("only src/server/audit.ts calls prisma.auditLog.create", () => {
    const offenders = tsFiles(join(process.cwd(), "src"))
      .filter((f) => !f.endsWith(join("src", "server", "audit.ts")))
      .filter((f) => readFileSync(f, "utf8").includes("prisma.auditLog.create"));
    expect(offenders).toEqual([]);
  });
});
