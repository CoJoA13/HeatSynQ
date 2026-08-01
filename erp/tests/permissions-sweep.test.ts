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

  it("no service mutates Prisma outside an audit helper", () => {
    // Services call prisma.<model>.create/update INSIDE an audited* callback, so requiring an
    // audit* call somewhere in the same file is the cheap structural proxy. Pattern must match
    // auditSettingChange too — settings.ts upserts and audits through that helper, not audited*.
    // The mutation pattern deliberately does NOT require the literal token "prisma." — services
    // route through aliases too (customer-addresses.ts mutates via `db.customerAddress.*` and
    // `tx.customerAddress.*` inside a transaction; reference.ts mutates via `delegate(kind).*`,
    // with zero literal "prisma." occurrences in the file). Anchoring on "prisma." would make the
    // check vacuous for exactly the files that use those idioms — it would never see the mutation
    // at all, audited or not. Matching the method name regardless of receiver closes that.
    //
    // KNOWN LIMIT: this is a file-level proxy, not a call-level check. It only asks "does this
    // file contain a mutation call somewhere AND an audit call somewhere" — it does not tie a
    // specific mutation to the audit call guarding it. A service that mixes one audited mutation
    // and one unaudited mutation in the same file passes. That's an accepted gap: cheap enough to
    // catch a service written with zero audit discipline (the realistic failure mode when a new
    // service file is added and audit is simply forgotten), not a substitute for reviewing each
    // mutation individually.
    const EXCEPT = new Set([
      "audit.ts",    // owns the helpers; legitimately writes audit rows itself
      "db.ts",       // the client
      "sessions.ts", // sliding session expiry is not a business mutation and writes no audit row
    ]);
    const offenders = readdirSync(join(process.cwd(), "src/server"))
      .filter((f) => f.endsWith(".ts") && !EXCEPT.has(f))
      .filter((f) => {
        const s = readFileSync(join(process.cwd(), "src/server", f), "utf8");
        const mutates = /\.(create|update|upsert|delete)(Many)?\s*\(/.test(s);
        const audits = /\baudit(ed)?[A-Z][A-Za-z]*\s*\(/.test(s);
        return mutates && !audits;
      });
    expect(offenders).toEqual([]);
  });
});
