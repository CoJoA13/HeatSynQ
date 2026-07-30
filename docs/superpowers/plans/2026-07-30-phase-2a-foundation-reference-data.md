# Phase 2A — Foundation Refactors + Reference Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the five Phase 1 "Task 0" refactors, then deliver every reference table the owner needs — GL accounts, Process Step Codes with their configurable field definitions, and ten flat pick-lists — each with Excel export and spreadsheet paste-entry.

**Architecture:** Phase 1's conventions hold throughout (HANDOFF §5): services own business rules, route handlers are `handle()` + `requireUser()` + `mustCan()` + zod parse + delegate, every mutation flows through the audit helpers, soft delete only. The refactors come first because they change `requireUser`'s signature and the module import graph that every later task builds on. The reference tables then establish one generic CRUD pattern — service, routes, list UI, Excel export, paste grid — that Phases 2B–2D reuse for customers, parts, and process steps.

**Tech Stack:** Next.js 15.5.22 (App Router), React 19, Prisma 6.19.3 + PostgreSQL 16, zod 4, vitest 3 against a real `erp_test` database, Tailwind 4, `exceljs` (new dependency, Task 9).

## Global Constraints

- **Node 22+**, npm. All commands run from `erp/`.
- **Quality gates, green at every commit:** `npm test`, `npx tsc --noEmit`, `npx eslint src tests`.
- **Migrations apply to BOTH databases.** After any `schema.prisma` edit:
  `npx prisma migrate dev --name <name>` then
  `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`
  Skipping the second leaves the suite on a stale schema.
- **Soft delete only** — `deletedAt`, never a hard delete outside tests.
- **Every mutation goes through `auditedCreate` / `auditedUpdate` / `auditedSoftDelete`.** Extend `AuditableModel` for each new entity, and `SNAPSHOT_INCLUDE` where relations are mutated through the parent.
- **Client components must never import from `src/server/**`** — shared constants live in `src/lib/`.
- **Route handler tests must pass ctx:** `handler(request, { params: Promise.resolve({}) })`.
- **Reference data is gated by the `admin` area** (`admin.view` / `admin.create` / `admin.edit` / `admin.delete`). Spec §9 fixes the 12 areas; adding a "plant data" area would be a spec change, so reference maintenance lives under admin.
- **Naming (owner, 2026-07-30):** UI says **Process Steps** for a part's recipe and **Process Step Code** for the billable reference table. The word "Operation" from earlier drafts must not appear in code or UI.
- **Conventional commits**, ending with the `Co-Authored-By` line used throughout `git log`.
- Tests share one database: `truncateAll()` in `beforeEach`, `fileParallelism: false`. Do not parallelize.

---

## File Structure

**Created:**
- `src/server/errors.ts` — `HttpError` only. No imports. Breaks the `settings → http → sessions → settings` cycle.
- `src/server/db-errors.ts` — Prisma error translation (P2002 → 400, P2025 → 404).
- `src/server/reference.ts` — generic reference-table CRUD, driven by a config map.
- `src/lib/reference-constants.ts` — reference entity metadata safe for client import (keys, labels, field lists).
- `src/server/process-step-codes.ts` — Process Step Code service + its field definitions (richer than flat references).
- `src/server/excel.ts` — `toXlsx(columns, rows)` helper.
- `src/server/paste.ts` — TSV parse + per-row validation used by every quick-entry grid.
- `src/app/api/admin/reference/[kind]/route.ts`, `.../[kind]/[id]/route.ts`, `.../[kind]/export/route.ts`, `.../[kind]/paste/route.ts`
- `src/app/api/admin/step-codes/**` — list/create/update/delete plus field definitions.
- `src/app/admin/reference/page.tsx`, `src/app/admin/step-codes/page.tsx`
- `src/components/PasteGrid.tsx`, `src/components/ReferenceTable.tsx`

**Modified:**
- `src/server/context.ts` — carries the resolved user, not just the actor.
- `src/server/http.ts` — `handle()` resolves the session once; `requireUser()` becomes synchronous and reads the stash.
- `src/server/sessions.ts` — owns the `SessionUser` type.
- `src/server/audit.ts` — `AuditableModel` and `SNAPSHOT_INCLUDE` gain every new entity.
- `src/server/settings.ts`, `roles.ts`, `users.ts`, `permissions.ts` — import `HttpError` from `errors.ts`.
- All ten existing route files — `requireUser()` call shape.
- `src/components/Shell.tsx` — admin nav gains Reference data and Process Step Codes.
- `tests/helpers/setup.ts` — dotenv `quiet: true`.
- `prisma/schema.prisma` — 13 new models.

---

## Task 1: Extract HttpError into its own module

Done first: Task 2's context refactor needs an import graph without the `settings → http → sessions → settings` cycle.

**Files:**
- Create: `erp/src/server/errors.ts`
- Modify: `erp/src/server/http.ts`, `settings.ts`, `permissions.ts`, `roles.ts`, `users.ts`, `erp/src/app/api/admin/audit/route.ts`
- Test: `erp/tests/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class HttpError extends Error { constructor(status: number, message: string); status: number }` from `@/server/errors`. `@/server/http` re-exports it so existing imports keep compiling.

- [ ] **Step 1: Write the failing test**

```ts
// erp/tests/errors.test.ts
import { describe, it, expect } from "vitest";
import { HttpError } from "@/server/errors";
import { HttpError as ReExported } from "@/server/http";

describe("HttpError", () => {
  it("carries status and message", () => {
    const err = new HttpError(404, "Not found");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Not found");
    expect(err).toBeInstanceOf(Error);
  });

  it("is the same class when imported via http (re-export, not a copy)", () => {
    expect(ReExported).toBe(HttpError);
    expect(new ReExported(400, "x")).toBeInstanceOf(HttpError);
  });

  it("errors.ts imports nothing — the module graph stays acyclic", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/server/errors.ts", import.meta.url), "utf8"));
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/errors.test.ts`
Expected: FAIL — `Cannot find module '@/server/errors'`.

- [ ] **Step 3: Create errors.ts**

```ts
// erp/src/server/errors.ts
// No imports, deliberately. This module is the graph's leaf so that services can throw
// HttpError without pulling in next/server or Prisma, which is what created the
// settings -> http -> sessions -> settings cycle.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
```

- [ ] **Step 4: Point http.ts at it and re-export**

In `erp/src/server/http.ts`, delete the `export class HttpError {...}` block and add near the top:

```ts
import { HttpError } from "./errors";
export { HttpError };
```

- [ ] **Step 5: Repoint the direct importers**

In each of `settings.ts`, `permissions.ts`, `roles.ts`, `users.ts`, change `from "./http"` to `from "./errors"` **on the HttpError import only** (`permissions.ts` has it on line 34, mid-file — leave its position, just change the specifier). In `src/app/api/admin/audit/route.ts`, split the import:

```ts
import { handle, requireUser } from "@/server/http";
import { HttpError } from "@/server/errors";
```

- [ ] **Step 6: Verify no cycle remains and the suite is green**

```bash
npx vitest run tests/errors.test.ts
npm test
npx tsc --noEmit
npx eslint src tests
```
Expected: all pass, 78 tests (75 + 3 new).

- [ ] **Step 7: Commit**

```bash
git add src/server/errors.ts src/server/http.ts src/server/settings.ts src/server/permissions.ts \
        src/server/roles.ts src/server/users.ts src/app/api/admin/audit/route.ts tests/errors.test.ts
git commit -m "refactor: extract HttpError into errors.ts, breaking the settings/http/sessions cycle"
```

---

## Task 2: Resolve the session once per request

Today `handle()` resolves the session and then `requireUser()` resolves it *again*. Each resolution also reads `session_timeout_minutes` and writes a sliding-expiry update — so every authenticated request costs **2 session reads + 2 settings reads + 2 session writes**.

**Files:**
- Modify: `erp/src/server/sessions.ts`, `context.ts`, `http.ts`, `erp/src/app/api/auth/me/route.ts`, and all ten route files
- Create: `erp/tests/helpers/auth.ts` — shared sign-in helper. Tasks 5 and 9 need the same login boilerplate; writing it three times would be verbatim duplication of a logic block, which the review rubric treats as a defect.
- Test: `erp/tests/request-context.test.ts`, plus updates to existing route tests

**Interfaces:**
- Consumes: `HttpError` from Task 1.
- Produces:
  - `sessions.ts`: `export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>`
  - `context.ts`: `runWithContext(ctx: RequestContext, fn: () => Promise<T>): Promise<T>`, `currentActor(): Actor`, `currentUser(): SessionUser | null`, `type RequestContext = { actor: Actor; user: SessionUser | null }`
  - `http.ts`: **`requireUser(): SessionUser`** — now **synchronous, no `req` argument**. Every call site becomes `mustCan(requireUser(), "area", "action")`.

- [ ] **Step 1: Write the shared sign-in helper**

```ts
// erp/tests/helpers/auth.ts
import { prisma } from "./db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";

/**
 * Creates a role carrying exactly `permissions`, a user holding it, and returns that
 * user's session cookie. Used by every route test that needs an authenticated request.
 */
export async function signInWith(permissions: string[], username = "root"): Promise<string> {
  const role = await prisma.role.create({
    data: {
      name: `Role-${username}`,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
  await prisma.user.create({
    data: {
      username, displayName: username,
      passwordHash: await hashPassword("secret1"), roleId: role.id,
    },
  });
  const res = await login(new Request("http://t/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "secret1" }),
  }), { params: Promise.resolve({}) });
  return res.headers.get("set-cookie")!.split(";")[0];
}
```

- [ ] **Step 1b: Write the failing test**

```ts
// erp/tests/request-context.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { GET as me } from "@/app/api/auth/me/route";

describe("request context", () => {
  beforeEach(async () => await truncateAll());

  it("resolves the session exactly once per request", async () => {
    const cookie = await signInWith(["admin.view"]);
    const spy = vi.spyOn(prisma.session, "update");
    const res = await me(new Request("http://t/api/auth/me", { headers: { cookie } }),
                         { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    // One sliding-expiry write, not two.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("me returns effective permissions via the shared resolver", async () => {
    const cookie = await signInWith(["admin.view"]);
    const res = await me(new Request("http://t/api/auth/me", { headers: { cookie } }),
                         { params: Promise.resolve({}) });
    expect(await res.json()).toMatchObject({ username: "root", permissions: ["admin.view"] });
  });

  it("DENY override beats a role grant in the me payload", async () => {
    const cookie = await signInWith(["admin.view"]);
    const user = await prisma.user.findUniqueOrThrow({ where: { username: "root" } });
    await prisma.userPermissionOverride.create({
      data: { userId: user.id, permission: "admin.view", mode: "DENY" },
    });
    const res = await me(new Request("http://t/api/auth/me", { headers: { cookie } }),
                         { params: Promise.resolve({}) });
    expect((await res.json()).permissions).toEqual([]);
  });

  it("401s with no cookie", async () => {
    const res = await me(new Request("http://t/api/auth/me"), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/request-context.test.ts`
Expected: FAIL — the first case reports 2 calls to `session.update`, not 1.

- [ ] **Step 3: Move the SessionUser type onto sessions.ts**

Append to `erp/src/server/sessions.ts`:

```ts
export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;
```

- [ ] **Step 4: Widen the context to carry the user**

Replace the body of `erp/src/server/context.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";
// Type-only import: erased at compile time, so this does NOT create a runtime cycle with
// sessions -> settings -> context.
import type { SessionUser } from "./sessions";

export type Actor = { id: string | null; name: string };
export type RequestContext = { actor: Actor; user: SessionUser | null };

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentActor(): Actor {
  return storage.getStore()?.actor ?? { id: null, name: "system" };
}

export function currentUser(): SessionUser | null {
  return storage.getStore()?.user ?? null;
}
```

- [ ] **Step 5: Make handle() the single resolution point**

Replace `requireUser` and `handle` in `erp/src/server/http.ts`:

```ts
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
        return NextResponse.json({ error: `${issue.path.join(".") || "body"}: ${issue.message}` }, { status: 400 });
      }
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  };
}
```

Update the imports at the top of `http.ts` to `import { runWithContext, currentUser } from "./context";` and `import { getSessionUser, type SessionUser } from "./sessions";`, and re-export the type: `export type { SessionUser };`

- [ ] **Step 6: Update every call site**

In all ten route files, `await requireUser(req)` becomes `requireUser()`. Example — `src/app/api/admin/roles/route.ts`:

```ts
export const GET = handle(async () => {
  mustCan(requireUser(), "admin", "view");
  return NextResponse.json(await listRoles());
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "admin", "edit");
  const { name } = z.object({ name: z.string().min(1) }).parse(await req.json());
  return NextResponse.json(await createRole(name));
});
```

Apply the same shape to: `api/admin/audit/route.ts`, `api/admin/roles/[id]/route.ts`, `api/admin/settings/route.ts`, `api/admin/users/route.ts`, `api/admin/users/[id]/route.ts`, `api/auth/me/route.ts`, `api/auth/logout/route.ts`.

- [ ] **Step 7: Make me/route.ts use the shared resolver**

Replace `erp/src/app/api/auth/me/route.ts` — it currently re-implements DENY>GRANT>role by hand, a second copy of the rule that will drift:

```ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { ALL_PERMISSIONS, can, canDo, AREAS, CRUD_ACTIONS, SPECIAL_ACTIONS } from "@/server/permissions";

export const GET = handle(async () => {
  const user = requireUser();
  const permissions = ALL_PERMISSIONS.filter((key) => {
    const [head, tail] = key.split(".");
    return head === "action"
      ? canDo(user, tail as (typeof SPECIAL_ACTIONS)[number])
      : can(user, head as (typeof AREAS)[number], tail as (typeof CRUD_ACTIONS)[number]);
  });
  return NextResponse.json({
    id: user.id, username: user.username, displayName: user.displayName, permissions,
  });
});
```

- [ ] **Step 8: Fix existing tests that call requireUser directly**

Search and update: `grep -rn "requireUser" tests/`. Any direct call drops its argument and its `await`.

- [ ] **Step 9: Run the full suite**

```bash
npm test
npx tsc --noEmit
npx eslint src tests
```
Expected: all green, 82 tests.

- [ ] **Step 10: Commit**

```bash
git add src/server/context.ts src/server/http.ts src/server/sessions.ts src/app/api tests/
git commit -m "refactor: resolve the session once per request via AsyncLocalStorage"
```

---

## Task 3: Prisma error hygiene

Bogus ids currently surface as 500s, and `createUser`'s duplicate check has a check-then-insert race.

**Files:**
- Create: `erp/src/server/db-errors.ts`
- Modify: `erp/src/server/users.ts`, `roles.ts`
- Test: `erp/tests/db-errors.test.ts`

**Interfaces:**
- Consumes: `HttpError` from Task 1.
- Produces: `translatePrisma(err: unknown, opts: { entity: string; conflictField?: string }): never` and `withDbErrors<T>(opts, fn: () => Promise<T>): Promise<T>` from `@/server/db-errors`.

- [ ] **Step 1: Write the failing test**

```ts
// erp/tests/db-errors.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { withDbErrors } from "@/server/db-errors";
import { HttpError } from "@/server/errors";
import { createRole, renameRole } from "@/server/roles";

describe("db error hygiene", () => {
  beforeEach(async () => await truncateAll());

  it("maps a unique violation to 400", async () => {
    await prisma.role.create({ data: { name: "Office" } });
    const boom = withDbErrors({ entity: "Role", conflictField: "name" }, () =>
      prisma.role.create({ data: { name: "Office" } }));
    await expect(boom).rejects.toThrow(HttpError);
    await expect(boom).rejects.toMatchObject({ status: 400 });
  });

  it("maps a missing record to 404", async () => {
    const boom = withDbErrors({ entity: "Role" }, () =>
      prisma.role.update({ where: { id: "does-not-exist" }, data: { name: "x" } }));
    await expect(boom).rejects.toMatchObject({ status: 404, message: "Role not found" });
  });

  it("lets unrelated errors through untouched", async () => {
    const boom = withDbErrors({ entity: "Role" }, async () => { throw new Error("kaboom"); });
    await expect(boom).rejects.toThrow("kaboom");
    await expect(boom).rejects.not.toBeInstanceOf(HttpError);
  });

  it("renameRole on a bogus id is a 404, not a 500", async () => {
    await expect(renameRole("nope", "Whatever")).rejects.toMatchObject({ status: 404 });
  });

  it("createRole survives a concurrent duplicate insert", async () => {
    const results = await Promise.allSettled([createRole("Race"), createRole("Race")]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(HttpError);
    expect(await prisma.role.count({ where: { name: "Race" } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db-errors.test.ts`
Expected: FAIL — `Cannot find module '@/server/db-errors'`.

- [ ] **Step 3: Write db-errors.ts**

```ts
// erp/src/server/db-errors.ts
import { Prisma } from "@prisma/client";
import { HttpError } from "./errors";

export type DbErrorOpts = { entity: string; conflictField?: string };

/** Translate the two Prisma failures that are expected business outcomes, not bugs. */
export function translatePrisma(err: unknown, opts: DbErrorOpts): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const field = opts.conflictField ?? (err.meta?.target as string[] | undefined)?.join(", ") ?? "value";
      throw new HttpError(400, `A ${opts.entity.toLowerCase()} with that ${field} already exists`);
    }
    if (err.code === "P2025") throw new HttpError(404, `${opts.entity} not found`);
  }
  throw err;
}

export async function withDbErrors<T>(opts: DbErrorOpts, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    translatePrisma(err, opts);
  }
}
```

- [ ] **Step 4: Retrofit roles.ts and users.ts**

Wrap the mutating calls. In `roles.ts`, `createRole`'s create branch and `renameRole`'s update:

```ts
: await auditedCreate("role", { name }, () =>
    withDbErrors({ entity: "Role", conflictField: "name" }, () => prisma.role.create({ data: { name } })));
```

```ts
export async function renameRole(roleId: string, name: string): Promise<void> {
  const existing = await prisma.role.findUnique({ where: { name } });
  if (existing && !existing.deletedAt && existing.id !== roleId) {
    throw new HttpError(400, "A role with that name already exists");
  }
  await withDbErrors({ entity: "Role", conflictField: "name" }, () =>
    auditedUpdate("role", roleId, () => prisma.role.update({ where: { id: roleId }, data: { name } })));
}
```

In `users.ts`, wrap `createUser`'s `prisma.user.create` with `withDbErrors({ entity: "User", conflictField: "username" }, ...)` and `updateUser`'s `prisma.user.update` with `withDbErrors({ entity: "User" }, ...)`. Keep the existing pre-checks — they produce friendlier messages on the common path; `withDbErrors` is the race backstop.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/db-errors.test.ts && npm test`
Expected: PASS, 87 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/db-errors.ts src/server/roles.ts src/server/users.ts tests/db-errors.test.ts
git commit -m "fix: map Prisma P2002/P2025 to 400/404 instead of leaking 500s"
```

---

## Task 4: Redact settings audit values, silence dotenv

Two one-liners. Settings is the only sanctioned direct audit writer, and it bypasses `redact()` — harmless today, but Phase 5 puts QBO credentials in settings.

**Files:**
- Modify: `erp/src/server/audit.ts`, `settings.ts`, `erp/tests/helpers/setup.ts`
- Test: `erp/tests/settings.test.ts` (add a case)

**Interfaces:**
- Produces: `redact` becomes an exported function from `@/server/audit`.

- [ ] **Step 1: Write the failing test**

Append to `erp/tests/settings.test.ts`:

```ts
it("routes audit values through redact so secrets never land in the log", async () => {
  const { redact } = await import("@/server/audit");
  expect(redact({ value: { token: "sk-live-123", host: "qbo" } }))
    .toEqual({ value: { token: "[redacted]", host: "qbo" } });

  await setSetting("company_name", "Acme Heat Treat");
  const [entry] = await readAudit("setting", "company_name");
  expect(entry.after).toEqual({ value: "Acme Heat Treat" });
});
```

Ensure the file imports `readAudit` from `@/server/audit` and `setSetting` from `@/server/settings`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings.test.ts -t "routes audit values through redact"`
Expected: FAIL — `redact` is not exported.

- [ ] **Step 3: Export redact**

In `erp/src/server/audit.ts`, change `function redact(` to `export function redact(`.

- [ ] **Step 4: Use it in settings.ts**

In `setSetting`, import `redact` alongside the existing audit imports and wrap both sides:

```ts
await prisma.auditLog.create({
  data: {
    actorId: actor.id, actorName: actor.name, entity: "setting", entityId: key, action: "update",
    before: redact(before ? { value: before.value } : { value: def.default }),
    after: redact({ value: parsed.data }),
  },
});
```

- [ ] **Step 5: Silence dotenv**

Replace `erp/tests/helpers/setup.ts`:

```ts
import { config } from "dotenv";
config({ quiet: true });
// Point every prisma client in the test process at the test database.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
```

- [ ] **Step 6: Run tests and confirm clean output**

Run: `npm test`
Expected: PASS, 88 tests, and **no** `◇ injected env (3) from .env` promo lines.

- [ ] **Step 7: Commit**

```bash
git add src/server/audit.ts src/server/settings.ts tests/helpers/setup.ts tests/settings.test.ts
git commit -m "fix: redact settings audit payloads; silence dotenv in test output"
```

---

## Task 5: GL Account — the first reference entity

Establishes the schema shape, service shape, and route shape that Task 6 generalizes.

**Files:**
- Modify: `erp/prisma/schema.prisma`, `erp/src/server/audit.ts`
- Create: `erp/src/server/reference.ts`, `erp/src/lib/reference-constants.ts`, `erp/src/app/api/admin/reference/[kind]/route.ts`, `erp/src/app/api/admin/reference/[kind]/[id]/route.ts`
- Test: `erp/tests/reference-gl.test.ts`

**Interfaces:**
- Consumes: `withDbErrors` (Task 3), `requireUser()` (Task 2).
- Produces, from `@/server/reference`:
  - `listReference(kind: ReferenceKind, opts?: { includeInactive?: boolean }): Promise<ReferenceRow[]>`
  - `createReference(kind: ReferenceKind, input: Record<string, unknown>): Promise<{ id: string }>`
  - `updateReference(kind: ReferenceKind, id: string, input: Record<string, unknown>): Promise<void>`
  - `deleteReference(kind: ReferenceKind, id: string): Promise<void>`
  - `type ReferenceRow = { id: string; name: string; active: boolean; [extra: string]: unknown }`
- From `@/lib/reference-constants`: `REFERENCE_KINDS`, `type ReferenceKind`, `REFERENCE_LABELS`.

- [ ] **Step 1: Write the failing test**

```ts
// erp/tests/reference-gl.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { listReference, createReference, updateReference, deleteReference } from "@/server/reference";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";

describe("GL account reference", () => {
  beforeEach(async () => await truncateAll());

  it("creates, lists, and orders by name", async () => {
    await createReference("glAccount", { name: "4020", description: "Straightening Revenue" });
    await createReference("glAccount", { name: "4010", description: "Heat Treat Revenue" });
    const rows = await listReference("glAccount");
    expect(rows.map((r) => r.name)).toEqual(["4010", "4020"]);
    expect(rows[0]).toMatchObject({ description: "Heat Treat Revenue", active: true });
  });

  it("rejects a duplicate account number", async () => {
    await createReference("glAccount", { name: "4010" });
    await expect(createReference("glAccount", { name: "4010" })).rejects.toThrow(HttpError);
  });

  it("soft deletes — the row leaves the list but survives in the table", async () => {
    const { id } = await createReference("glAccount", { name: "4010" });
    await deleteReference("glAccount", id);
    expect(await listReference("glAccount")).toHaveLength(0);
    expect(await prisma.glAccount.findUnique({ where: { id } })).not.toBeNull();
  });

  it("hides inactive rows unless asked", async () => {
    const { id } = await createReference("glAccount", { name: "4010" });
    await updateReference("glAccount", id, { active: false });
    expect(await listReference("glAccount")).toHaveLength(0);
    expect(await listReference("glAccount", { includeInactive: true })).toHaveLength(1);
  });

  it("audits every mutation with a usable diff", async () => {
    const { id } = await createReference("glAccount", { name: "4010", description: "Heat Treat" });
    await updateReference("glAccount", id, { description: "Heat Treat Revenue" });
    const entries = await readAudit("glAccount", id);
    expect(entries.map((e) => e.action)).toEqual(["update", "create"]);
    expect((entries[0].before as { description: string }).description).toBe("Heat Treat");
    expect((entries[0].after as { description: string }).description).toBe("Heat Treat Revenue");
  });

  it("404s on an unknown id and rejects an unknown kind", async () => {
    await expect(updateReference("glAccount", "nope", { name: "x" })).rejects.toMatchObject({ status: 404 });
    // `kind` is typed `string` on purpose so routes can pass a raw path segment — the guard
    // is runtime, not compile time. No @ts-expect-error here: the call type-checks fine, and
    // an unused directive is a hard tsc failure (TS2578).
    await expect(listReference("notAKind")).rejects.toMatchObject({ status: 400 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reference-gl.test.ts`
Expected: FAIL — `Cannot find module '@/server/reference'`.

- [ ] **Step 3: Add the model**

Append to `erp/prisma/schema.prisma`:

```prisma
model GlAccount {
  id          String    @id @default(cuid())
  name        String    @unique          // the account number, e.g. "4010"
  description String    @default("")
  active      Boolean   @default(true)
  deletedAt   DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}
```

- [ ] **Step 4: Migrate both databases**

```bash
npx prisma migrate dev --name gl_account
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```

- [ ] **Step 5: Write the client-safe constants**

```ts
// erp/src/lib/reference-constants.ts
// Pure constants — safe to import from client components (no server imports).
export const REFERENCE_KINDS = ["glAccount"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const REFERENCE_LABELS: Record<ReferenceKind, { singular: string; plural: string; nameLabel: string }> = {
  glAccount: { singular: "GL account", plural: "GL accounts", nameLabel: "Account number" },
};
```

- [ ] **Step 6: Write the generic service**

```ts
// erp/src/server/reference.ts
import { z } from "zod";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { REFERENCE_KINDS, REFERENCE_LABELS, type ReferenceKind } from "../lib/reference-constants";

export type ReferenceRow = { id: string; name: string; active: boolean } & Record<string, unknown>;

/** Fields each kind accepts beyond `name` and `active`. */
const EXTRA_SCHEMAS: Record<ReferenceKind, z.ZodObject<z.ZodRawShape>> = {
  glAccount: z.object({ description: z.string().max(200).optional() }),
};

const BASE = z.object({ name: z.string().min(1).max(100), active: z.boolean().optional() });

/** Exported so paste.ts guards on the same rule rather than re-deriving it. */
export function assertKind(kind: string): asserts kind is ReferenceKind {
  if (!(REFERENCE_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(400, `Unknown reference kind: ${kind}`);
  }
}

// Every reference kind is a Prisma delegate with the same id/name/active/deletedAt shape.
type RefDelegate = {
  findMany: (a: object) => Promise<ReferenceRow[]>;
  create: (a: { data: object }) => Promise<{ id: string }>;
  update: (a: { where: { id: string }; data: object }) => Promise<unknown>;
};
function delegate(kind: ReferenceKind): RefDelegate {
  return prisma[kind] as unknown as RefDelegate;
}

export async function listReference(
  kind: string, opts?: { includeInactive?: boolean },
): Promise<ReferenceRow[]> {
  assertKind(kind);
  return delegate(kind).findMany({
    where: { deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: { name: "asc" },
  });
}

export async function createReference(kind: string, input: Record<string, unknown>): Promise<{ id: string }> {
  assertKind(kind);
  const data = BASE.merge(EXTRA_SCHEMAS[kind]).parse(input);
  const row = await auditedCreate(kind, data, () =>
    withDbErrors({ entity: REFERENCE_LABELS[kind].singular, conflictField: "name" }, () =>
      delegate(kind).create({ data })));
  return { id: row.id };
}

export async function updateReference(kind: string, id: string, input: Record<string, unknown>): Promise<void> {
  assertKind(kind);
  const data = BASE.partial().merge(EXTRA_SCHEMAS[kind].partial()).parse(input);
  await withDbErrors({ entity: REFERENCE_LABELS[kind].singular, conflictField: "name" }, () =>
    auditedUpdate(kind, id, () => delegate(kind).update({ where: { id }, data })));
}

export async function deleteReference(kind: string, id: string): Promise<void> {
  assertKind(kind);
  await withDbErrors({ entity: REFERENCE_LABELS[kind].singular }, () => auditedSoftDelete(kind, id));
}
```

- [ ] **Step 7: Extend the audit model union**

In `erp/src/server/audit.ts`:

```ts
export type AuditableModel = "user" | "role" | "setting" | "glAccount";
```

and add to `SNAPSHOT_INCLUDE`:

```ts
glAccount: undefined,
```

- [ ] **Step 8: Run the service tests**

Run: `npx vitest run tests/reference-gl.test.ts`
Expected: PASS.

- [ ] **Step 9: Add the routes**

```ts
// erp/src/app/api/admin/reference/[kind]/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listReference, createReference } from "@/server/reference";

export const GET = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const { kind } = await params;
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  return NextResponse.json(await listReference(kind, { includeInactive }));
});

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "create");
  const { kind } = await params;
  return NextResponse.json(await createReference(kind, await req.json()));
});
```

```ts
// erp/src/app/api/admin/reference/[kind]/[id]/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateReference, deleteReference } from "@/server/reference";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "edit");
  const { kind, id } = await params;
  await updateReference(kind, id, await req.json());
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "delete");
  const { kind, id } = await params;
  await deleteReference(kind, id);
  return NextResponse.json({ ok: true });
});
```

- [ ] **Step 10: Test the routes for 401 and 403**

Append to `erp/tests/reference-gl.test.ts`:

```ts
import { GET as listRoute, POST as createRoute } from "@/app/api/admin/reference/[kind]/route";
import { signInWith } from "./helpers/auth";

describe("reference routes", () => {
  beforeEach(async () => await truncateAll());
  const ctx = { params: Promise.resolve({ kind: "glAccount" }) };

  it("401s without a session", async () => {
    const res = await listRoute(new Request("http://t/api/admin/reference/glAccount"), ctx);
    expect(res.status).toBe(401);
  });

  it("403s for a signed-in user without admin.create", async () => {
    const cookie = await signInWith(["admin.view"]);

    const ok = await listRoute(new Request("http://t/api/admin/reference/glAccount", { headers: { cookie } }), ctx);
    expect(ok.status).toBe(200);

    const denied = await createRoute(new Request("http://t/api/admin/reference/glAccount", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "4010" }),
    }), ctx);
    expect(denied.status).toBe(403);
  });
});
```

- [ ] **Step 11: Run and commit**

```bash
npm test && npx tsc --noEmit && npx eslint src tests
git add prisma src/server/reference.ts src/lib/reference-constants.ts src/server/audit.ts \
        src/app/api/admin/reference tests/reference-gl.test.ts
git commit -m "feat: GL account reference table with generic reference service and routes"
```

---

## Task 6: The remaining flat reference tables

Ten more entities through the Task 5 pattern. Two carry extra fields.

**Files:**
- Modify: `erp/prisma/schema.prisma`, `erp/src/lib/reference-constants.ts`, `erp/src/server/reference.ts`, `erp/src/server/audit.ts`
- Test: `erp/tests/reference-tables.test.ts`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: `REFERENCE_KINDS` grows to eleven members. No new function signatures.

- [ ] **Step 1: Write the failing test**

```ts
// erp/tests/reference-tables.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { listReference, createReference } from "@/server/reference";
import { REFERENCE_KINDS } from "@/lib/reference-constants";
import { HttpError } from "@/server/errors";

describe("flat reference tables", () => {
  beforeEach(async () => await truncateAll());

  it("exposes every kind the owner needs to key", () => {
    expect([...REFERENCE_KINDS].sort()).toEqual([
      "carrier", "commentSnippet", "containerType", "glAccount", "inspectionCode",
      "inspectionScale", "material", "paymentType", "salesperson", "specification", "terms",
    ]);
  });

  it("round-trips create+list for every kind", async () => {
    for (const kind of REFERENCE_KINDS) {
      await createReference(kind, { name: `${kind}-1` });
      const rows = await listReference(kind);
      expect(rows, kind).toHaveLength(1);
      expect(rows[0].name, kind).toBe(`${kind}-1`);
    }
  });

  it("rejects duplicate names on every kind", async () => {
    for (const kind of REFERENCE_KINDS) {
      await createReference(kind, { name: "dup" });
      await expect(createReference(kind, { name: "dup" }), kind).rejects.toThrow(HttpError);
    }
  });

  it("inspection code carries an optional default scale", async () => {
    const scale = await createReference("inspectionScale", { name: "Brinell" });
    const { id } = await createReference("inspectionCode", { name: "HB", defaultScaleId: scale.id });
    const row = (await listReference("inspectionCode")).find((r) => r.id === id);
    expect(row?.defaultScaleId).toBe(scale.id);
  });

  it("payment type carries an optional GL account", async () => {
    const gl = await createReference("glAccount", { name: "1010" });
    const { id } = await createReference("paymentType", { name: "Check", glAccountId: gl.id });
    const row = (await listReference("paymentType")).find((r) => r.id === id);
    expect(row?.glAccountId).toBe(gl.id);
  });

  it("comment snippet and specification carry a text body", async () => {
    await createReference("commentSnippet", { name: "Liability", text: "Seller's liability is limited to…" });
    await createReference("specification", { name: "AMS 2759/1", text: "Heat treatment of steel parts" });
    expect((await listReference("commentSnippet"))[0].text).toMatch(/liability/i);
    expect((await listReference("specification"))[0].text).toMatch(/steel/i);
  });

  it("rejects an unknown extra field rather than silently dropping it", async () => {
    await expect(createReference("material", { name: "1045", bogus: true })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reference-tables.test.ts`
Expected: FAIL — `REFERENCE_KINDS` has one member.

- [ ] **Step 3: Add the ten models**

Append to `erp/prisma/schema.prisma`:

```prisma
model Material {
  id        String    @id @default(cuid())
  name      String    @unique
  active    Boolean   @default(true)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model InspectionScale {
  id        String            @id @default(cuid())
  name      String            @unique
  active    Boolean           @default(true)
  deletedAt DateTime?
  createdAt DateTime          @default(now())
  updatedAt DateTime          @updatedAt
  codes     InspectionCode[]
}

model InspectionCode {
  id             String           @id @default(cuid())
  name           String           @unique
  defaultScaleId String?
  defaultScale   InspectionScale? @relation(fields: [defaultScaleId], references: [id])
  active         Boolean          @default(true)
  deletedAt      DateTime?
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt
}

model ContainerType {
  id        String    @id @default(cuid())
  name      String    @unique
  active    Boolean   @default(true)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model Carrier {
  id        String    @id @default(cuid())
  name      String    @unique
  active    Boolean   @default(true)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model Terms {
  id        String    @id @default(cuid())
  name      String    @unique
  active    Boolean   @default(true)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model PaymentType {
  id          String     @id @default(cuid())
  name        String     @unique
  glAccountId String?
  glAccount   GlAccount? @relation(fields: [glAccountId], references: [id])
  active      Boolean    @default(true)
  deletedAt   DateTime?
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
}

model Salesperson {
  id        String    @id @default(cuid())
  name      String    @unique
  active    Boolean   @default(true)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model CommentSnippet {
  id        String    @id @default(cuid())
  name      String    @unique
  text      String    @default("")
  active    Boolean   @default(true)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model Specification {
  id        String    @id @default(cuid())
  name      String    @unique
  text      String    @default("")
  active    Boolean   @default(true)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}
```

Add the back-relation on `GlAccount`: `paymentTypes PaymentType[]`.

- [ ] **Step 4: Migrate both databases**

```bash
npx prisma migrate dev --name reference_tables
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```

- [ ] **Step 5: Extend the constants**

```ts
// erp/src/lib/reference-constants.ts
export const REFERENCE_KINDS = [
  "glAccount", "material", "inspectionScale", "inspectionCode", "containerType",
  "carrier", "terms", "paymentType", "salesperson", "commentSnippet", "specification",
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const REFERENCE_LABELS: Record<ReferenceKind, { singular: string; plural: string; nameLabel: string }> = {
  glAccount:       { singular: "GL account",       plural: "GL accounts",       nameLabel: "Account number" },
  material:        { singular: "Material",         plural: "Materials",         nameLabel: "Name" },
  inspectionScale: { singular: "Inspection scale", plural: "Inspection scales", nameLabel: "Name" },
  inspectionCode:  { singular: "Inspection code",  plural: "Inspection codes",  nameLabel: "Code" },
  containerType:   { singular: "Container type",   plural: "Container types",   nameLabel: "Name" },
  carrier:         { singular: "Carrier",          plural: "Carriers",          nameLabel: "Name" },
  terms:           { singular: "Terms",            plural: "Terms",             nameLabel: "Name" },
  paymentType:     { singular: "Payment type",     plural: "Payment types",     nameLabel: "Name" },
  salesperson:     { singular: "Salesperson",      plural: "Salespeople",       nameLabel: "Name" },
  commentSnippet:  { singular: "Comment snippet",  plural: "Comment snippets",  nameLabel: "Name" },
  specification:   { singular: "Specification",    plural: "Specifications",    nameLabel: "Name" },
};

/** Extra columns beyond name/active, for the generic list UI and Excel export. */
export const REFERENCE_EXTRA_FIELDS: Record<ReferenceKind, { key: string; label: string; kind: "text" | "ref" }[]> = {
  glAccount:       [{ key: "description",    label: "Description",   kind: "text" }],
  inspectionCode:  [{ key: "defaultScaleId", label: "Default scale", kind: "ref" }],
  paymentType:     [{ key: "glAccountId",    label: "GL account",    kind: "ref" }],
  commentSnippet:  [{ key: "text",           label: "Text",          kind: "text" }],
  specification:   [{ key: "text",           label: "Text",          kind: "text" }],
  material: [], inspectionScale: [], containerType: [], carrier: [], terms: [], salesperson: [],
};
```

- [ ] **Step 6: Extend the service schemas**

In `erp/src/server/reference.ts`, replace `EXTRA_SCHEMAS`:

```ts
const EXTRA_SCHEMAS: Record<ReferenceKind, z.ZodObject<z.ZodRawShape>> = {
  glAccount:       z.object({ description: z.string().max(200).optional() }),
  inspectionCode:  z.object({ defaultScaleId: z.string().nullable().optional() }),
  paymentType:     z.object({ glAccountId: z.string().nullable().optional() }),
  commentSnippet:  z.object({ text: z.string().max(4000).optional() }),
  specification:   z.object({ text: z.string().max(4000).optional() }),
  material: z.object({}), inspectionScale: z.object({}), containerType: z.object({}),
  carrier: z.object({}), terms: z.object({}), salesperson: z.object({}),
};
```

**Already done — pulled forward into Task 5's fix round.** Task 5's review flagged the silent-strip as Critical rather than letting it replicate across ten entities, so `.strict()` is already applied in both `createReference` and `updateReference`. Verify it is still there (`grep -n "strict()" src/server/reference.ts` → two hits) and move on; do not add it twice.

Task 5's fix round also added **revival on create** for soft-deleted names, following the `roles.ts` precedent. That behaviour now applies to every kind you add here — a soft-deleted `Material` named "1045" is revived rather than rejected when re-created. Your round-trip tests should not be surprised by it.

- [ ] **Step 7: Extend the audit union**

```ts
export type AuditableModel =
  | "user" | "role" | "setting"
  | "glAccount" | "material" | "inspectionScale" | "inspectionCode" | "containerType"
  | "carrier" | "terms" | "paymentType" | "salesperson" | "commentSnippet" | "specification";
```

Add `undefined` entries to `SNAPSHOT_INCLUDE` for each new key — none of them mutate relations through a parent.

- [ ] **Step 8: Run and commit**

```bash
npx vitest run tests/reference-tables.test.ts && npm test && npx tsc --noEmit && npx eslint src tests
git add prisma src/lib/reference-constants.ts src/server/reference.ts src/server/audit.ts tests/reference-tables.test.ts
git commit -m "feat: ten flat reference tables through the generic reference service"
```

---

## Task 7: Process Step Code and its field definitions

Richer than the flat tables: each code owns an ordered list of field definitions that drive what a recipe step of that kind asks for. This is the owner's 2026-07-30 decision — Austenitize exposes temperature/time/carbon potential, Hot Wash exposes none.

**Files:**
- Modify: `erp/prisma/schema.prisma`, `erp/src/server/audit.ts`
- Create: `erp/src/server/process-step-codes.ts`, `erp/src/lib/step-field-constants.ts`, `erp/src/app/api/admin/step-codes/route.ts`, `erp/src/app/api/admin/step-codes/[id]/route.ts`
- Test: `erp/tests/process-step-codes.test.ts`

**Interfaces:**
- Consumes: `withDbErrors`, `requireUser()`, audit helpers.
- Produces, from `@/server/process-step-codes`:
  - `listStepCodes(opts?: { includeInactive?: boolean }): Promise<StepCode[]>`
  - `createStepCode(input: { code: string; name: string; glAccountId?: string | null; equipmentTag?: string }): Promise<{ id: string }>`
  - `updateStepCode(id: string, input: Partial<{ code: string; name: string; glAccountId: string | null; equipmentTag: string; active: boolean }>): Promise<void>`
  - `deleteStepCode(id: string): Promise<void>`
  - `setStepFields(id: string, fields: StepFieldInput[]): Promise<void>`
  - `type StepFieldInput = { label: string; type: "NUMBER" | "TEXT" | "DATE" | "CHECKBOX"; unit?: string | null; sort: number }`
  - `type StepCode = { id: string; code: string; name: string; glAccountId: string | null; equipmentTag: string; active: boolean; needsGlAccount: boolean; fields: (StepFieldInput & { id: string })[] }`
- From `@/lib/step-field-constants`: `STEP_FIELD_TYPES = ["NUMBER","TEXT","DATE","CHECKBOX"] as const`.

- [ ] **Step 1: Write the failing test**

```ts
// erp/tests/process-step-codes.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import {
  listStepCodes, createStepCode, updateStepCode, deleteStepCode, setStepFields,
} from "@/server/process-step-codes";
import { createReference } from "@/server/reference";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";

describe("process step codes", () => {
  beforeEach(async () => await truncateAll());

  it("creates a code without a GL account and flags that it needs one", async () => {
    await createStepCode({ code: "HT-01", name: "Austenitize" });
    const [row] = await listStepCodes();
    expect(row).toMatchObject({ code: "HT-01", name: "Austenitize", glAccountId: null, needsGlAccount: true });
  });

  it("clears the needsGlAccount flag once an account is attached", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await updateStepCode(id, { glAccountId: gl.id });
    expect((await listStepCodes())[0].needsGlAccount).toBe(false);
  });

  it("rejects a duplicate code", async () => {
    await createStepCode({ code: "HT-01", name: "Austenitize" });
    await expect(createStepCode({ code: "HT-01", name: "Other" })).rejects.toThrow(HttpError);
  });

  it("stores ordered field definitions and returns them in sort order", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [
      { label: "Carbon potential", type: "NUMBER", sort: 3 },
      { label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
      { label: "Time", type: "NUMBER", unit: "min", sort: 2 },
    ]);
    const fields = (await listStepCodes())[0].fields;
    expect(fields.map((f) => f.label)).toEqual(["Temperature", "Time", "Carbon potential"]);
    expect(fields[0].unit).toBe("F");
  });

  it("a code with no fields is valid — Hot Wash is text only", async () => {
    const { id } = await createStepCode({ code: "WS-01", name: "Hot Wash" });
    await setStepFields(id, []);
    expect((await listStepCodes()).find((c) => c.id === id)?.fields).toEqual([]);
  });

  it("setStepFields replaces the whole set rather than appending", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    await setStepFields(id, [{ label: "Time", type: "NUMBER", sort: 1 }]);
    const fields = (await listStepCodes())[0].fields;
    expect(fields.map((f) => f.label)).toEqual(["Time"]);
  });

  it("rejects an unknown field type", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    // @ts-expect-error deliberately invalid type
    await expect(setStepFields(id, [{ label: "X", type: "COLOUR", sort: 1 }])).rejects.toThrow();
  });

  it("audits field changes with a diff that names the fields", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await setStepFields(id, [{ label: "Temperature", type: "NUMBER", sort: 1 }]);
    const [entry] = await readAudit("processStepCode", id);
    const after = (entry.after as { fields: { label: string }[] }).fields.map((f) => f.label);
    expect(after).toEqual(["Temperature"]);
  });

  it("soft deletes", async () => {
    const { id } = await createStepCode({ code: "HT-01", name: "Austenitize" });
    await deleteStepCode(id);
    expect(await listStepCodes()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/process-step-codes.test.ts`
Expected: FAIL — `Cannot find module '@/server/process-step-codes'`.

- [ ] **Step 3: Add the models**

```prisma
enum StepFieldType {
  NUMBER
  TEXT
  DATE
  CHECKBOX
}

model ProcessStepCode {
  id           String                 @id @default(cuid())
  code         String                 @unique
  name         String
  glAccountId  String?
  glAccount    GlAccount?             @relation(fields: [glAccountId], references: [id])
  equipmentTag String                 @default("")
  active       Boolean                @default(true)
  deletedAt    DateTime?
  createdAt    DateTime               @default(now())
  updatedAt    DateTime               @updatedAt
  fields       ProcessStepFieldDef[]
}

model ProcessStepFieldDef {
  id       String        @id @default(cuid())
  codeId   String
  code     ProcessStepCode @relation(fields: [codeId], references: [id], onDelete: Cascade)
  label    String
  type     StepFieldType
  unit     String?
  sort     Int
  @@unique([codeId, label])
}
```

Add `processStepCodes ProcessStepCode[]` to `GlAccount`.

- [ ] **Step 4: Migrate both databases**

```bash
npx prisma migrate dev --name process_step_codes
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```

- [ ] **Step 5: Client-safe field-type constants**

```ts
// erp/src/lib/step-field-constants.ts
export const STEP_FIELD_TYPES = ["NUMBER", "TEXT", "DATE", "CHECKBOX"] as const;
export type StepFieldType = (typeof STEP_FIELD_TYPES)[number];
```

- [ ] **Step 6: Write the service**

```ts
// erp/src/server/process-step-codes.ts
import { z } from "zod";
import { prisma } from "./db";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { STEP_FIELD_TYPES, type StepFieldType } from "../lib/step-field-constants";

export type StepFieldInput = { label: string; type: StepFieldType; unit?: string | null; sort: number };
export type StepCode = {
  id: string; code: string; name: string; glAccountId: string | null;
  equipmentTag: string; active: boolean; needsGlAccount: boolean;
  fields: (StepFieldInput & { id: string })[];
};

const FIELD = z.object({
  label: z.string().min(1).max(60),
  type: z.enum(STEP_FIELD_TYPES),
  unit: z.string().max(20).nullable().optional(),
  sort: z.number().int().min(0),
});

const CREATE = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(100),
  glAccountId: z.string().nullable().optional(),
  equipmentTag: z.string().max(60).optional(),
}).strict();

export async function listStepCodes(opts?: { includeInactive?: boolean }): Promise<StepCode[]> {
  const rows = await prisma.processStepCode.findMany({
    where: { deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    include: { fields: { orderBy: { sort: "asc" } } },
    orderBy: { code: "asc" },
  });
  return rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, glAccountId: r.glAccountId,
    equipmentTag: r.equipmentTag, active: r.active,
    // Surfaced in the UI and asserted by Phase 5 before any QBO export runs.
    needsGlAccount: r.glAccountId === null,
    fields: r.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, unit: f.unit, sort: f.sort })),
  }));
}

export async function createStepCode(input: z.input<typeof CREATE>): Promise<{ id: string }> {
  const data = CREATE.parse(input);
  const row = await auditedCreate("processStepCode", data, () =>
    withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
      prisma.processStepCode.create({ data })));
  return { id: row.id };
}

export async function updateStepCode(id: string, input: Partial<z.input<typeof CREATE>> & { active?: boolean }) {
  const data = CREATE.partial().extend({ active: z.boolean().optional() }).strict().parse(input);
  await withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
    auditedUpdate("processStepCode", id, () => prisma.processStepCode.update({ where: { id }, data })));
}

export async function deleteStepCode(id: string): Promise<void> {
  await withDbErrors({ entity: "Process step code" }, () => auditedSoftDelete("processStepCode", id));
}

/** Replaces the entire field-definition set for a code. */
export async function setStepFields(id: string, fields: StepFieldInput[]): Promise<void> {
  const parsed = z.array(FIELD).parse(fields);
  await withDbErrors({ entity: "Process step code" }, () =>
    auditedUpdate("processStepCode", id, () =>
      prisma.$transaction([
        prisma.processStepFieldDef.deleteMany({ where: { codeId: id } }),
        prisma.processStepFieldDef.createMany({
          data: parsed.map((f) => ({ codeId: id, label: f.label, type: f.type, unit: f.unit ?? null, sort: f.sort })),
        }),
      ])));
}
```

- [ ] **Step 7: Extend the audit union — with the relation this time**

```ts
export type AuditableModel = /* … existing … */ | "processStepCode";
```

In `SNAPSHOT_INCLUDE`, this one is **not** `undefined` — fields are mutated through the parent, so without the include the audit diff would show nothing when `setStepFields` runs:

```ts
processStepCode: { fields: true },
```

- [ ] **Step 8: Add the routes**

```ts
// erp/src/app/api/admin/step-codes/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listStepCodes, createStepCode } from "@/server/process-step-codes";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "admin", "view");
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  return NextResponse.json(await listStepCodes({ includeInactive }));
});

export const POST = handle(async (req) => {
  mustCan(requireUser(), "admin", "create");
  return NextResponse.json(await createStepCode(await req.json()));
});
```

```ts
// erp/src/app/api/admin/step-codes/[id]/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { updateStepCode, deleteStepCode, setStepFields } from "@/server/process-step-codes";

export const PUT = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "edit");
  const { id } = await params;
  const body = await req.json();
  // `fields` is replaced wholesale and travels separately from the scalar columns.
  if (Array.isArray(body.fields)) {
    await setStepFields(id, body.fields);
    delete body.fields;
  }
  if (Object.keys(body).length) await updateStepCode(id, body);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req, { params }) => {
  mustCan(requireUser(), "admin", "delete");
  await deleteStepCode((await params).id);
  return NextResponse.json({ ok: true });
});
```

- [ ] **Step 9: Run and commit**

```bash
npx vitest run tests/process-step-codes.test.ts && npm test && npx tsc --noEmit && npx eslint src tests
git add prisma src/server/process-step-codes.ts src/lib/step-field-constants.ts src/server/audit.ts \
        src/app/api/admin/step-codes tests/process-step-codes.test.ts
git commit -m "feat: process step codes with configurable field definitions"
```

---

## Task 8: Reference data UI

**Files:**
- Create: `erp/src/components/ReferenceTable.tsx`, `erp/src/app/admin/reference/page.tsx`, `erp/src/app/admin/step-codes/page.tsx`
- Modify: `erp/src/components/Shell.tsx`

**Interfaces:**
- Consumes: `REFERENCE_KINDS`, `REFERENCE_LABELS`, `REFERENCE_EXTRA_FIELDS` from `@/lib/reference-constants`; `STEP_FIELD_TYPES` from `@/lib/step-field-constants`; the routes from Tasks 5–7. **No `src/server/**` imports** — these are client components.
- Produces: `<ReferenceTable kind={...} />`.

- [ ] **Step 1: Write the reference table component**

```tsx
// erp/src/components/ReferenceTable.tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { HistoryPanel } from "@/components/HistoryPanel";
import { REFERENCE_LABELS, REFERENCE_EXTRA_FIELDS, type ReferenceKind } from "@/lib/reference-constants";

type Row = { id: string; name: string; active: boolean } & Record<string, unknown>;

export function ReferenceTable({ kind }: { kind: ReferenceKind }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const labels = REFERENCE_LABELS[kind];
  const extras = REFERENCE_EXTRA_FIELDS[kind];

  const load = useCallback(async () => {
    setRows(await api<Row[]>(`/api/admin/reference/${kind}${showInactive ? "?includeInactive=1" : ""}`));
  }, [kind, showInactive]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function add() {
    try {
      await api(`/api/admin/reference/${kind}`, { method: "POST", body: JSON.stringify(draft) });
      setDraft({}); setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function toggleActive(row: Row) {
    try {
      await api(`/api/admin/reference/${kind}/${row.id}`, {
        method: "PUT", body: JSON.stringify({ active: !row.active }),
      });
      setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function remove(row: Row) {
    if (!confirm(`Delete ${labels.singular.toLowerCase()} "${row.name}"?`)) return;
    try {
      await api(`/api/admin/reference/${kind}/${row.id}`, { method: "DELETE" });
      setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="mb-2 flex items-center gap-3">
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <a href={`/api/admin/reference/${kind}/export`} className="text-sm text-blue-700 underline">
          Export to Excel
        </a>
      </div>
      <table className="w-full rounded border bg-white text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">{labels.nameLabel}</th>
            {extras.map((f) => <th key={f.key} className="p-2">{f.label}</th>)}
            <th className="p-2">Active</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="p-2">{r.name}</td>
              {extras.map((f) => <td key={f.key} className="p-2">{String(r[f.key] ?? "")}</td>)}
              <td className="p-2">
                <input type="checkbox" checked={r.active} onChange={() => toggleActive(r)} />
              </td>
              <td className="p-2 text-right">
                <button onClick={() => setOpenHistory(openHistory === r.id ? null : r.id)}
                        className="mr-3 text-xs text-slate-600">history</button>
                <button onClick={() => remove(r)} className="text-xs text-red-600">delete</button>
                {openHistory === r.id && <HistoryPanel entity={kind} entityId={r.id} />}
              </td>
            </tr>
          ))}
          <tr className="border-t bg-slate-50">
            <td className="p-2">
              <input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                     placeholder={labels.nameLabel} className="w-full rounded border px-2 py-1" />
            </td>
            {extras.map((f) => (
              <td key={f.key} className="p-2">
                <input value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                       placeholder={f.label} className="w-full rounded border px-2 py-1" />
              </td>
            ))}
            <td />
            <td className="p-2 text-right">
              <button onClick={add} className="rounded bg-slate-800 px-3 py-1 text-white">Add</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Write the reference page**

```tsx
// erp/src/app/admin/reference/page.tsx
"use client";
import { useState } from "react";
import { ReferenceTable } from "@/components/ReferenceTable";
import { REFERENCE_KINDS, REFERENCE_LABELS, type ReferenceKind } from "@/lib/reference-constants";

export default function ReferencePage() {
  const [kind, setKind] = useState<ReferenceKind>("glAccount");
  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Reference data</h1>
      <div className="flex gap-6">
        <ul className="w-56 shrink-0 divide-y rounded border bg-white text-sm">
          {REFERENCE_KINDS.map((k) => (
            <li key={k}
                className={`cursor-pointer px-3 py-2 ${k === kind ? "bg-slate-100 font-medium" : ""}`}
                onClick={() => setKind(k)}>
              {REFERENCE_LABELS[k].plural}
            </li>
          ))}
        </ul>
        <div className="flex-1"><ReferenceTable kind={kind} /></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the step-codes page**

```tsx
// erp/src/app/admin/step-codes/page.tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { STEP_FIELD_TYPES, type StepFieldType } from "@/lib/step-field-constants";

type Field = { id?: string; label: string; type: StepFieldType; unit: string | null; sort: number };
type Code = {
  id: string; code: string; name: string; glAccountId: string | null;
  active: boolean; needsGlAccount: boolean; fields: Field[];
};
type Gl = { id: string; name: string; description?: string };

export default function StepCodesPage() {
  const [codes, setCodes] = useState<Code[]>([]);
  const [gls, setGls] = useState<Gl[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState({ code: "", name: "" });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, g] = await Promise.all([
      api<Code[]>("/api/admin/step-codes"),
      api<Gl[]>("/api/admin/reference/glAccount"),
    ]);
    setCodes(c); setGls(g);
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  const current = codes.find((c) => c.id === selected) ?? null;

  async function save(id: string, body: object) {
    try {
      await api(`/api/admin/step-codes/${id}`, { method: "PUT", body: JSON.stringify(body) });
      setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function add() {
    try {
      await api("/api/admin/step-codes", { method: "POST", body: JSON.stringify(draft) });
      setDraft({ code: "", name: "" }); setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  function mutateFields(next: Field[]) {
    if (current) void save(current.id, { fields: next.map((f, i) => ({ ...f, sort: i })) });
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Process step codes</h1>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="flex gap-6">
        <div className="w-72 shrink-0">
          <ul className="mb-3 divide-y rounded border bg-white text-sm">
            {codes.map((c) => (
              <li key={c.id} onClick={() => setSelected(c.id)}
                  className={`cursor-pointer px-3 py-2 ${selected === c.id ? "bg-slate-100" : ""}`}>
                <span className="font-mono">{c.code}</span> {c.name}
                {c.needsGlAccount && (
                  <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-800">needs GL</span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex gap-1">
            <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                   placeholder="Code" className="w-24 rounded border px-2 py-1 text-sm" />
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                   placeholder="Name" className="flex-1 rounded border px-2 py-1 text-sm" />
            <button onClick={add} className="rounded bg-slate-800 px-3 py-1 text-sm text-white">Add</button>
          </div>
        </div>

        {current && (
          <div className="flex-1 rounded border bg-white p-4">
            <h2 className="mb-3 font-medium">{current.code} — {current.name}</h2>
            <label className="mb-4 block text-sm">
              GL account
              <select value={current.glAccountId ?? ""} className="ml-2 rounded border px-2 py-1"
                      onChange={(e) => save(current.id, { glAccountId: e.target.value || null })}>
                <option value="">(needs GL account)</option>
                {gls.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
              </select>
            </label>

            <h3 className="mb-2 font-medium">Fields a step of this kind asks for</h3>
            <table className="mb-2 w-full text-sm">
              <thead><tr className="text-left"><th>Label</th><th>Type</th><th>Unit</th><th /></tr></thead>
              <tbody>
                {current.fields.map((f, i) => (
                  <tr key={f.id ?? i} className="border-t">
                    <td className="py-1">{f.label}</td>
                    <td>{f.type}</td>
                    <td>{f.unit ?? ""}</td>
                    <td className="text-right">
                      <button className="text-xs text-red-600"
                              onClick={() => mutateFields(current.fields.filter((_, j) => j !== i))}>
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <AddField onAdd={(f) => mutateFields([...current.fields, f])} />
            <p className="mt-3 text-xs text-slate-500">
              A code with no fields is text-only — that is correct for steps like Hot Wash.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function AddField({ onAdd }: { onAdd: (f: Field) => void }) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<StepFieldType>("NUMBER");
  const [unit, setUnit] = useState("");
  return (
    <div className="flex gap-1">
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Field label"
             className="flex-1 rounded border px-2 py-1 text-sm" />
      <select value={type} onChange={(e) => setType(e.target.value as StepFieldType)}
              className="rounded border px-2 py-1 text-sm">
        {STEP_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit"
             className="w-20 rounded border px-2 py-1 text-sm" />
      <button className="rounded bg-slate-800 px-3 py-1 text-sm text-white"
              onClick={() => { if (label) { onAdd({ label, type, unit: unit || null, sort: 0 }); setLabel(""); setUnit(""); } }}>
        Add field
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Add both to the admin nav**

In `erp/src/components/Shell.tsx`, extend `ADMIN`:

```ts
const ADMIN = [
  { label: "Users", href: "/admin/users" },
  { label: "Roles", href: "/admin/roles" },
  { label: "Reference data", href: "/admin/reference" },
  { label: "Process step codes", href: "/admin/step-codes" },
  { label: "Settings", href: "/admin/settings" },
  { label: "Audit log", href: "/admin/audit" },
];
```

- [ ] **Step 5: Verify by hand**

```bash
npm run dev
```
Sign in as admin/admin. Visit `/admin/reference` — add a GL account `4010 / Heat Treat Revenue`, toggle Show inactive, expand history and confirm the create entry. Visit `/admin/step-codes` — add `HT-01 / Austenitize`, confirm the amber **needs GL** badge, attach `4010` and watch it clear, then add fields Temperature (NUMBER, F), Time (NUMBER, min), Carbon potential (NUMBER).

- [ ] **Step 6: Run gates and commit**

```bash
npm test && npx tsc --noEmit && npx eslint src tests
git add src/components/ReferenceTable.tsx src/app/admin/reference src/app/admin/step-codes src/components/Shell.tsx
git commit -m "feat: reference data and process step code admin pages"
```

---

## Task 9: Excel export

Spec §6 promises Excel on every list. CSV is not what was promised.

**Files:**
- Create: `erp/src/server/excel.ts`, `erp/src/app/api/admin/reference/[kind]/export/route.ts`
- Modify: `erp/package.json`
- Test: `erp/tests/excel.test.ts`

**Interfaces:**
- Consumes: `listReference` (Task 5).
- Produces: `toXlsx(sheetName: string, columns: { key: string; header: string }[], rows: Record<string, unknown>[]): Promise<Buffer>` from `@/server/excel`.

- [ ] **Step 1: Install exceljs**

```bash
npm install exceljs
```

- [ ] **Step 2: Write the failing test**

```ts
// erp/tests/excel.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { truncateAll } from "./helpers/db";
import { toXlsx } from "@/server/excel";
import { createReference } from "@/server/reference";
import { GET as exportRoute } from "@/app/api/admin/reference/[kind]/export/route";
import { signInWith } from "./helpers/auth";

describe("excel export", () => {
  beforeEach(async () => await truncateAll());

  it("produces a real workbook with a header row and the data", async () => {
    const buf = await toXlsx("GL accounts",
      [{ key: "name", header: "Account number" }, { key: "description", header: "Description" }],
      [{ name: "4010", description: "Heat Treat Revenue" }]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheet = wb.getWorksheet("GL accounts")!;
    expect(sheet.getRow(1).values).toEqual([undefined, "Account number", "Description"]);
    expect(sheet.getRow(2).values).toEqual([undefined, "4010", "Heat Treat Revenue"]);
  });

  it("the export route returns an xlsx content type and 401s without a session", async () => {
    const ctx = { params: Promise.resolve({ kind: "glAccount" }) };
    const anon = await exportRoute(new Request("http://t/api/admin/reference/glAccount/export"), ctx);
    expect(anon.status).toBe(401);

    const cookie = await signInWith(["admin.view"]);
    await createReference("glAccount", { name: "4010", description: "Heat Treat Revenue" });
    const res = await exportRoute(
      new Request("http://t/api/admin/reference/glAccount/export", { headers: { cookie } }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/spreadsheetml/);
    expect(res.headers.get("content-disposition")).toMatch(/glAccount.*\.xlsx/);
    expect(Buffer.from(await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/excel.test.ts`
Expected: FAIL — `Cannot find module '@/server/excel'`.

- [ ] **Step 4: Write the helper**

```ts
// erp/src/server/excel.ts
import ExcelJS from "exceljs";

export async function toXlsx(
  sheetName: string,
  columns: { key: string; header: string }[],
  rows: Record<string, unknown>[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(sheetName);
  sheet.columns = columns.map((c) => ({ key: c.key, header: c.header, width: Math.max(14, c.header.length + 2) }));
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
```

- [ ] **Step 5: Write the export route**

```ts
// erp/src/app/api/admin/reference/[kind]/export/route.ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listReference } from "@/server/reference";
import { toXlsx } from "@/server/excel";
import { REFERENCE_LABELS, REFERENCE_EXTRA_FIELDS, type ReferenceKind } from "@/lib/reference-constants";

export const GET = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "view");
  const { kind } = await params;
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  const rows = await listReference(kind, { includeInactive });

  const labels = REFERENCE_LABELS[kind as ReferenceKind];
  const columns = [
    { key: "name", header: labels.nameLabel },
    ...REFERENCE_EXTRA_FIELDS[kind as ReferenceKind].map((f) => ({ key: f.key, header: f.label })),
    { key: "active", header: "Active" },
  ];

  const buf = await toXlsx(labels.plural, columns, rows as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${kind}.xlsx"`,
    },
  });
});
```

Note: `listReference` calls `assertKind`, so an unknown `kind` throws `HttpError(400)` before the label lookup — the casts are safe.

- [ ] **Step 6: Run and commit**

```bash
npx vitest run tests/excel.test.ts && npm test && npx tsc --noEmit && npx eslint src tests
git add package.json package-lock.json src/server/excel.ts src/app/api/admin/reference tests/excel.test.ts
git commit -m "feat: Excel export for reference lists"
```

---

## Task 10: Quick-entry paste grid

Spec §13's headline Phase 2 feature — the difference between keying masters being a sitting and being a project. Built here on reference tables so Phases 2B–2D reuse it.

**Files:**
- Create: `erp/src/server/paste.ts`, `erp/src/app/api/admin/reference/[kind]/paste/route.ts`, `erp/src/components/PasteGrid.tsx`
- Modify: `erp/src/components/ReferenceTable.tsx`
- Test: `erp/tests/paste.test.ts`

**Interfaces:**
- Consumes: `createReference` (Task 5), `REFERENCE_LABELS`/`REFERENCE_EXTRA_FIELDS`.
- Produces:
  - `parseTsv(text: string, columns: string[]): Record<string, string>[]` from `@/server/paste`
  - `type PasteResult = { created: number; errors: { row: number; message: string }[] }`
  - `pasteReference(kind: string, text: string): Promise<PasteResult>`

- [ ] **Step 1: Write the failing test**

```ts
// erp/tests/paste.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { parseTsv, pasteReference } from "@/server/paste";
import { listReference, createReference } from "@/server/reference";

describe("paste entry", () => {
  beforeEach(async () => await truncateAll());

  it("parses tab-separated rows into column-keyed objects", () => {
    const rows = parseTsv("4010\tHeat Treat\n4020\tStraightening", ["name", "description"]);
    expect(rows).toEqual([
      { name: "4010", description: "Heat Treat" },
      { name: "4020", description: "Straightening" },
    ]);
  });

  it("ignores blank lines and trims cells", () => {
    expect(parseTsv("  4010 \t Heat Treat \n\n\n", ["name", "description"]))
      .toEqual([{ name: "4010", description: "Heat Treat" }]);
  });

  it("tolerates short rows by filling missing columns with empty strings", () => {
    expect(parseTsv("4010", ["name", "description"])).toEqual([{ name: "4010", description: "" }]);
  });

  it("bulk-creates and reports the count", async () => {
    const result = await pasteReference("glAccount", "4010\tHeat Treat\n4020\tStraightening");
    expect(result).toEqual({ created: 2, errors: [] });
    expect(await listReference("glAccount")).toHaveLength(2);
  });

  it("reports per-row errors by 1-based row number and still commits the good rows", async () => {
    await createReference("glAccount", { name: "4010" });
    const result = await pasteReference("glAccount", "4010\tDup\n4030\tFine\n\t\tBlank name");
    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].row).toBe(1);
    expect(result.errors[0].message).toMatch(/already exists/i);
    expect(result.errors[1].row).toBe(3);
    const names = (await listReference("glAccount")).map((r) => r.name).sort();
    expect(names).toEqual(["4010", "4030"]);
  });

  it("rejects an unknown kind", async () => {
    await expect(pasteReference("nope", "x")).rejects.toMatchObject({ status: 400 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/paste.test.ts`
Expected: FAIL — `Cannot find module '@/server/paste'`.

- [ ] **Step 3: Write the parser and bulk creator**

```ts
// erp/src/server/paste.ts
import { createReference, assertKind } from "./reference";
import { REFERENCE_EXTRA_FIELDS } from "../lib/reference-constants";

export type PasteResult = { created: number; errors: { row: number; message: string }[] };

/** Split spreadsheet-pasted TSV into column-keyed rows. Short rows pad, long rows truncate. */
export function parseTsv(text: string, columns: string[]): Record<string, string>[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cells = line.split("\t");
      return Object.fromEntries(columns.map((c, i) => [c, (cells[i] ?? "").trim()]));
    });
}

/**
 * Creates every valid row and collects failures per row rather than aborting the batch —
 * a single typo in row 40 must not discard the 39 rows above it.
 */
export async function pasteReference(kind: string, text: string): Promise<PasteResult> {
  assertKind(kind);
  const columns = ["name", ...REFERENCE_EXTRA_FIELDS[kind].map((f) => f.key)];
  const rows = parseTsv(text, columns);

  const errors: PasteResult["errors"] = [];
  let created = 0;
  for (const [i, row] of rows.entries()) {
    // Drop empty optional cells so zod's .optional() applies instead of receiving "".
    const input = Object.fromEntries(Object.entries(row).filter(([k, v]) => k === "name" || v !== ""));
    try {
      await createReference(kind, input);
      created++;
    } catch (err) {
      errors.push({ row: i + 1, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { created, errors };
}
```

- [ ] **Step 4: Add the paste route**

```ts
// erp/src/app/api/admin/reference/[kind]/paste/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { pasteReference } from "@/server/paste";

export const POST = handle(async (req, { params }) => {
  mustCan(requireUser(), "admin", "create");
  const { kind } = await params;
  const { text } = z.object({ text: z.string().min(1).max(200_000) }).parse(await req.json());
  return NextResponse.json(await pasteReference(kind, text));
});
```

- [ ] **Step 5: Write the grid component**

```tsx
// erp/src/components/PasteGrid.tsx
"use client";
import { useState } from "react";
import { api } from "@/lib/fetcher";
import { REFERENCE_LABELS, REFERENCE_EXTRA_FIELDS, type ReferenceKind } from "@/lib/reference-constants";

type Result = { created: number; errors: { row: number; message: string }[] };

export function PasteGrid({ kind, onDone }: { kind: ReferenceKind; onDone: () => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const columns = [REFERENCE_LABELS[kind].nameLabel, ...REFERENCE_EXTRA_FIELDS[kind].map((f) => f.label)];

  async function submit() {
    setBusy(true);
    try {
      setResult(await api<Result>(`/api/admin/reference/${kind}/paste`, {
        method: "POST", body: JSON.stringify({ text }),
      }));
      onDone();
    } catch (e) {
      setResult({ created: 0, errors: [{ row: 0, message: (e as Error).message }] });
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-4 rounded border bg-white p-3">
      <p className="mb-2 text-sm">
        Paste from a spreadsheet. Columns, in order: <strong>{columns.join(" · ")}</strong>
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6}
                placeholder={`4010\tHeat Treat Revenue`}
                className="w-full rounded border p-2 font-mono text-xs" />
      <button onClick={submit} disabled={busy || !text.trim()}
              className="mt-2 rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:opacity-50">
        {busy ? "Importing…" : "Import rows"}
      </button>
      {result && (
        <div className="mt-3 text-sm">
          <p className="text-green-700">{result.created} row(s) created.</p>
          {result.errors.length > 0 && (
            <ul className="mt-1 text-red-700">
              {result.errors.map((e) => (
                <li key={e.row}>{e.row ? `Row ${e.row}: ` : ""}{e.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Wire it into ReferenceTable**

In `erp/src/components/ReferenceTable.tsx`, import `PasteGrid` and add a toggle. Inside the component add `const [pasting, setPasting] = useState(false);`, put a button next to the export link:

```tsx
<button onClick={() => setPasting((p) => !p)} className="text-sm text-blue-700 underline">
  {pasting ? "Hide paste entry" : "Paste from spreadsheet"}
</button>
```

and render below the table:

```tsx
{pasting && <PasteGrid kind={kind} onDone={load} />}
```

- [ ] **Step 7: Verify by hand**

```bash
npm run dev
```
At `/admin/reference` → GL accounts → **Paste from spreadsheet**, paste three tab-separated rows (make one a duplicate). Confirm the good rows import, the duplicate is reported by row number, and the table refreshes.

- [ ] **Step 8: Run gates and commit**

```bash
npm test && npx tsc --noEmit && npx eslint src tests
git add src/server/paste.ts src/app/api/admin/reference src/components/PasteGrid.tsx \
        src/components/ReferenceTable.tsx tests/paste.test.ts
git commit -m "feat: spreadsheet paste entry for reference tables"
```

---

## Task 11: Phase 2A close-out

**Files:**
- Modify: `erp/README.md`, `docs/HANDOFF.md`, `erp/src/server/http.ts` (validation messages, see Step 0)
- Test: `erp/tests/permissions-sweep.test.ts`, `erp/tests/validation-messages.test.ts`

- [ ] **Step 0: Fix validation messages in the running app (added 2026-07-30 after a Task 8 investigation)**

**The defect:** under Next's module resolution every zod validation error flattens to the generic string `"Invalid input"`, while the identical code under vitest produces specific messages. Reproduced against a fresh build with `.next` cleared:

| POST body to `/api/admin/reference/material` | running app | vitest |
|---|---|---|
| `{"name":""}` | `name: Invalid input` | `name: Too small: expected string to have >=1 characters` |
| `{"name":123}` | `name: Invalid input` | `name: Invalid input: expected string, received number` |
| `{"name":"X","description":"leaked"}` | `body: Invalid input` | `body: Unrecognized key: "description"` |

**Why it matters:** spec §12 promises "save-time errors are specific and field-anchored", and HANDOFF §5 item 5 makes field-anchored messages a standing convention. Every message-asserting test passes because vitest resolves zod differently than Next's bundler does — so the suite gives false confidence about the exact thing the spec promises. It becomes user-visible the moment the owner mistypes anything.

**Likely cause to investigate first:** zod 4 ships several entry points (`zod`, `zod/v4`, `zod/mini`) and registers its English locale separately. Next's server bundling probably resolves a build whose locale/messages are absent or tree-shaken, leaving `core`'s generic fallback. Confirm the mechanism before fixing — do not guess.

**The bar:** the three rows above must produce the specific message through a real HTTP call against a running dev server, not merely under vitest. Add `erp/tests/validation-messages.test.ts` asserting the specific text, and state in the report how you verified it through the running server, since a vitest-only assertion is exactly what failed to catch this.

If the root cause turns out to be genuinely outside our control (an upstream Next/zod interaction with no reasonable workaround), say so with evidence and implement the fallback instead: have `handle()` synthesise a specific message from the issue's `code`, `path`, and `keys` fields, which are present and correct in both runtimes even when `message` is not.

- [ ] **Step 1: Write the permission sweep test**

```ts
// erp/tests/permissions-sweep.test.ts
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

describe("permission sweep", () => {
  it("every API route calls requireUser", () => {
    const offenders = routeFiles(join(process.cwd(), "src/app/api"))
      .filter((f) => !readFileSync(f, "utf8").includes("requireUser"))
      // The health probe and login are deliberately public.
      .filter((f) => !f.includes("api/health") && !f.includes("api/auth/login"));
    expect(offenders).toEqual([]);
  });

  it("every admin route gates on a permission", () => {
    const offenders = routeFiles(join(process.cwd(), "src/app/api/admin"))
      .filter((f) => { const s = readFileSync(f, "utf8"); return !s.includes("mustCan") && !s.includes("mustDo"); });
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
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/permissions-sweep.test.ts`
Expected: PASS. If it fails, the named file is genuinely missing a guard — fix the route, not the test.

- [ ] **Step 3: Update the README**

Add under Development, after the seed step:

```markdown
### Reference data
Admin → Reference data maintains GL accounts, materials, inspection codes/scales, container types,
carriers, terms, payment types, salespeople, comment snippets, and specifications. Admin → Process
step codes maintains the billable step vocabulary and the fields each step kind asks for.
Every list exports to Excel and accepts spreadsheet paste.
```

- [ ] **Step 4: Update the handoff's build state**

In `docs/HANDOFF.md` §4, append to the Phase 1 paragraph:

```markdown
**Phase 2A (foundation refactors + reference data) is complete.** The five Task-0 refactors landed
(HttpError extracted, one session resolution per request, Prisma error hygiene, settings redaction,
quiet dotenv). Reference data ships with GL accounts, ten flat pick-lists, and Process Step Codes
with configurable field definitions — each with Excel export and spreadsheet paste entry.
```

- [ ] **Step 5: Final gates**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: all green. Test count should be roughly 115–125.

- [ ] **Step 6: Commit**

```bash
git add tests/permissions-sweep.test.ts README.md ../docs/HANDOFF.md
git commit -m "test: permission sweep; docs: Phase 2A close-out"
```

---

## Self-Review

**Spec coverage.** Kickoff §2.2 reference tables — Tasks 5–7. §2.2 GL optional with a visible needs-GL state — Task 7 (`needsGlAccount` + amber badge). §2.5 Excel export — Task 9. §2.5 quick-entry grids — Task 10. §2.5 HistoryPanel on detail — Task 8. Kickoff §1 pre-work items 1–5 — Tasks 1–4. **Deliberately out of this plan** and carried to 2B–2D: customers, parts, specs link, per-part Process Steps, revisions, templates, the Process Steps designer.

**Deviation from the kickoff's task order, with reason.** The brief put Excel export and quick-entry grids at tasks 11–12, after every entity. Building them here, against the simplest entity, means Phases 2B–2D wire their own lists as they build them rather than retrofitting eleven lists at the end.

**Open item the planner must carry into 2C.** Kickoff §6.2 — serialization is a real column if Phase 3 order entry validates against it, a custom field if it is only a note. Must be settled with the owner before the Part schema task.

**Type consistency check.** `requireUser()` is synchronous from Task 2 onward and every later task's routes call it that way. `ReferenceKind` is defined once in `@/lib/reference-constants` and consumed by service, routes, and both components. `AuditableModel` is extended in Tasks 5, 6, and 7 — cumulative, and only `processStepCode` gets a non-`undefined` `SNAPSHOT_INCLUDE`, because it is the only new entity mutating a relation through its parent.

---

## Remaining Phase 2 plans (written after this one executes)

- **2B — Customers:** customer, typed addresses, contacts, credit fields, standing notes; list/detail pages; export + paste wired.
- **2C — Parts:** part, specs link, inspection requirements with location, pricing and breaks, `PartFieldDef` custom fields; resolve the serialization question first.
- **2D — Process Steps:** per-part revisioned steps, templates, "Load Template" (asserting structure-only), the designer UI, revision history.
- **2E — Close:** owner demo script, seed data, whole-phase review.
