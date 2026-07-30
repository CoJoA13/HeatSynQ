# Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running, dockerized web app with login, owner-configurable roles/permissions, a full audit framework, typed settings, and the app shell — the base every later phase builds on.

**Architecture:** Next.js (App Router) full-stack app in `erp/`; PostgreSQL via Prisma; all business rules live in `src/server/` services (React components stay thin); session-cookie auth; permissions and audit are explicit service calls, not magic middleware.

**Tech Stack:** Next.js 15, React 19, TypeScript (strict), Prisma 6, PostgreSQL 16, Tailwind CSS 4, Vitest 3, argon2, zod.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-heat-treat-erp-design.md`. Phase 1 implements spec §9 (permissions/audit), §10 (settings framework), §11 (stack/deploy/backup), §12 conventions.
- TypeScript `strict: true`; no `any` unless commented why.
- **Every business rule lives in `erp/src/server/**` and is unit-tested there.** API route handlers and React components contain no business logic.
- **Every mutation goes through the audit helpers** (`src/server/audit.ts`) — never call `prisma.<model>.create/update/delete` directly for audited models (Task 8 defines the helpers; models before Task 8 are migrated onto them in Task 8).
- **Soft delete only** for business entities: set `deletedAt`; never `prisma.<model>.delete` outside tests.
- **Permission checks happen server-side** on every route handler via `requireUser` + `can`/`canDo`. UI hiding is convenience, not security.
- Tests: Vitest, run against the `erp_test` database (`npm test`). Every service function gets tests; TDD per task (test first, watch it fail, implement, watch it pass, commit).
- Commits after every task minimum, conventional style (`feat:`, `test:`, `chore:`).
- Paths below are relative to the repo root (`/home/cojoa13/Desktop/Claude new`); the app lives in `erp/`.
- Node 22+. All commands run from `erp/` unless a path is shown.

## File Structure (Phase 1 end state)

```
erp/
  docker-compose.yml          # postgres + app + nightly backup
  Dockerfile                  # multi-stage production build
  .env / .env.example         # DATABASE_URL, DATABASE_URL_TEST, SESSION_SECRET
  prisma/schema.prisma        # User, Session, Role, RolePermission, UserPermissionOverride, Setting, AuditLog
  prisma/seed.ts              # Admin role (all permissions) + admin user
  db-init/create-test-db.sql  # creates erp_test alongside erp
  scripts/backup.sh           # pg_dump wrapper used by the backup container
  src/
    server/
      db.ts                   # PrismaClient singleton
      context.ts              # AsyncLocalStorage<RequestActor> — who is acting, for audit
      password.ts             # hashPassword, verifyPassword (argon2id)
      sessions.ts             # createSession, getSessionUser, destroySession
      permissions.ts          # AREAS, CRUD_ACTIONS, SPECIAL_ACTIONS, can(), canDo(), grantAll()
      audit.ts                # auditedCreate/auditedUpdate/auditedSoftDelete + readAudit()
      settings.ts             # SETTINGS zod registry, getSetting, setSetting, allSettings
      users.ts                # user CRUD service (on audit helpers)
      roles.ts                # role CRUD service (on audit helpers)
      http.ts                 # requireUser(request), json helpers
    app/
      layout.tsx  page.tsx  globals.css
      login/page.tsx
      api/auth/login/route.ts   api/auth/logout/route.ts
      api/admin/users/route.ts  api/admin/users/[id]/route.ts
      api/admin/roles/route.ts  api/admin/roles/[id]/route.ts
      api/admin/settings/route.ts
      api/admin/audit/route.ts
      api/health/route.ts
      admin/users/page.tsx  admin/roles/page.tsx  admin/settings/page.tsx  admin/audit/page.tsx
    components/
      Shell.tsx               # left nav + header (permission-aware)
      HistoryPanel.tsx        # per-record audit history (used by every later phase)
    lib/fetcher.ts            # tiny client-side fetch wrapper
  tests/
    helpers/db.ts             # truncate helper + test prisma client
    password.test.ts  sessions.test.ts  permissions.test.ts
    audit.test.ts  settings.test.ts  users.test.ts  roles.test.ts
    auth-routes.test.ts  admin-routes.test.ts
  vitest.config.ts
```

---

### Task 1: Scaffold, database containers, test harness

**Files:**
- Create: `erp/` (via create-next-app), `erp/docker-compose.yml`, `erp/db-init/create-test-db.sql`, `erp/.env`, `erp/.env.example`, `erp/vitest.config.ts`, `erp/tests/helpers/db.ts`, `erp/src/server/db.ts`, `erp/src/app/api/health/route.ts`, `erp/tests/health.test.ts`
- Modify: `erp/package.json` (scripts), `.gitignore` (root)

**Interfaces:**
- Produces: `prisma` singleton export from `src/server/db.ts` (type `PrismaClient`); `tests/helpers/db.ts` exporting `truncateAll(): Promise<void>`; npm scripts `dev`, `test`, `db:migrate`, `db:seed`.

- [ ] **Step 1: Generate the app**

Run from repo root:

```bash
npx create-next-app@15 erp --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
cd erp
npm install prisma@6 @prisma/client@6 argon2 zod
npm install -D vitest@3 @vitest/coverage-v8 dotenv
npx prisma init --datasource-provider postgresql
```

Expected: `erp/` exists with `src/app/`, `prisma/schema.prisma` created.

- [ ] **Step 2: Database containers**

Create `erp/docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: erp
      POSTGRES_PASSWORD: erp_local_dev
      POSTGRES_DB: erp
    ports: ["5432:5432"]
    volumes:
      - dbdata:/var/lib/postgresql/data
      - ./db-init:/docker-entrypoint-initdb.d
volumes:
  dbdata:
```

Create `erp/db-init/create-test-db.sql`:

```sql
CREATE DATABASE erp_test OWNER erp;
```

Create `erp/.env` (and `.env.example` with the same keys, placeholder secret):

```bash
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp"
DATABASE_URL_TEST="postgresql://erp:erp_local_dev@localhost:5432/erp_test"
SESSION_SECRET="dev-change-me-32-chars-minimum!!"
```

Run: `docker compose up -d db` — expected: container healthy, `psql`-reachable.

- [ ] **Step 3: Prisma client singleton and npm scripts**

Create `erp/src/server/db.ts`:

```ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

Add to `erp/package.json` scripts:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:migrate": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "db:seed": "tsx prisma/seed.ts"
  }
}
```

Also `npm install -D tsx`.

- [ ] **Step 4: Vitest wired to the test database**

Create `erp/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/helpers/setup.ts"],
    fileParallelism: false, // one shared test DB — keep files sequential
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

Create `erp/tests/helpers/setup.ts`:

```ts
import { config } from "dotenv";
config();
// Point every prisma client in the test process at the test database.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
```

Create `erp/tests/helpers/db.ts`:

```ts
import { prisma } from "@/server/db";

/** Deletes all rows from every table except _prisma_migrations. */
export async function truncateAll(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

export { prisma };
```

- [ ] **Step 5: Failing health test**

Create `erp/src/app/api/health/route.ts` as an empty file for now, and `erp/tests/health.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/health/route";

describe("health endpoint", () => {
  it("reports ok and database connectivity", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, db: true });
  });
});
```

Run: `npm test` — expected: FAIL (`GET` is not exported).

- [ ] **Step 6: Implement health route**

`erp/src/app/api/health/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export async function GET() {
  await prisma.$queryRaw`SELECT 1`;
  return NextResponse.json({ ok: true, db: true });
}
```

Run: `npx prisma migrate dev --name init` (creates empty baseline), then `npm test` — expected: PASS.

- [ ] **Step 7: Root gitignore and commit**

Append to the **root** `.gitignore`:

```
erp/node_modules/
erp/.next/
erp/.env
erp/coverage/
```

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "feat: scaffold Next.js app with Postgres, Prisma, and Vitest harness"
```

---

### Task 2: Schema and seed — users, sessions, roles, permissions, settings, audit

**Files:**
- Modify: `erp/prisma/schema.prisma`
- Create: `erp/prisma/seed.ts`
- Test: `erp/tests/schema.test.ts`

**Interfaces:**
- Produces (Prisma models, exact fields used by later tasks):
  - `User { id: string(cuid), username: string @unique, passwordHash: string, displayName: string, roleId: string?, signatureImage: Bytes?, active: boolean(true), deletedAt: DateTime?, createdAt, updatedAt }`
  - `Session { id: string(cuid), tokenHash: string @unique, userId: string, expiresAt: DateTime, createdAt }`
  - `Role { id, name @unique, deletedAt: DateTime?, permissions: RolePermission[] }`
  - `RolePermission { id, roleId, permission: string }` with `@@unique([roleId, permission])`
  - `UserPermissionOverride { id, userId, permission: string, mode: "GRANT" | "DENY" }` with `@@unique([userId, permission])`
  - `Setting { key: string @id, value: Json, updatedAt, updatedBy: string? }`
  - `AuditLog { id, at: DateTime(now), actorId: string?, actorName: string, entity: string, entityId: string, action: string, before: Json?, after: Json?, reason: string? }` with `@@index([entity, entityId])` and `@@index([at])`
- Seed produces: role `Admin` holding **every** permission key, user `admin` / password `admin` (must-change note printed), linked to Admin.

- [ ] **Step 1: Failing schema test**

`erp/tests/schema.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, truncateAll } from "./helpers/db";

describe("schema", () => {
  beforeAll(async () => await truncateAll());

  it("creates a user with role and override", async () => {
    const role = await prisma.role.create({ data: { name: "Office" } });
    const user = await prisma.user.create({
      data: {
        username: "jane",
        passwordHash: "x",
        displayName: "Jane",
        roleId: role.id,
        overrides: { create: { permission: "orders.view", mode: "GRANT" } },
      },
      include: { overrides: true },
    });
    expect(user.overrides).toHaveLength(1);
    expect(user.active).toBe(true);
  });

  it("writes an audit row", async () => {
    const row = await prisma.auditLog.create({
      data: { actorName: "system", entity: "User", entityId: "u1", action: "create", after: { a: 1 } },
    });
    expect(row.at).toBeInstanceOf(Date);
  });
});
```

Run: `npm test tests/schema.test.ts` — expected: FAIL (models missing).

- [ ] **Step 2: Write the schema**

Replace the model section of `erp/prisma/schema.prisma` (keep generator/datasource blocks):

```prisma
model User {
  id             String    @id @default(cuid())
  username       String    @unique
  passwordHash   String
  displayName    String
  roleId         String?
  role           Role?     @relation(fields: [roleId], references: [id])
  signatureImage Bytes?
  active         Boolean   @default(true)
  deletedAt      DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  sessions       Session[]
  overrides      UserPermissionOverride[]
}

model Session {
  id        String   @id @default(cuid())
  tokenHash String   @unique
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  expiresAt DateTime
  createdAt DateTime @default(now())
}

model Role {
  id          String           @id @default(cuid())
  name        String           @unique
  deletedAt   DateTime?
  users       User[]
  permissions RolePermission[]
}

model RolePermission {
  id         String @id @default(cuid())
  roleId     String
  role       Role   @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission String
  @@unique([roleId, permission])
}

enum OverrideMode {
  GRANT
  DENY
}

model UserPermissionOverride {
  id         String       @id @default(cuid())
  userId     String
  user       User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  permission String
  mode       OverrideMode
  @@unique([userId, permission])
}

model Setting {
  key       String   @id
  value     Json
  updatedAt DateTime @updatedAt
  updatedBy String?
}

model AuditLog {
  id        String   @id @default(cuid())
  at        DateTime @default(now())
  actorId   String?
  actorName String
  entity    String
  entityId  String
  action    String
  before    Json?
  after     Json?
  reason    String?
  @@index([entity, entityId])
  @@index([at])
}
```

- [ ] **Step 3: Migrate both databases and verify test passes**

```bash
npx prisma migrate dev --name core-auth-audit-settings
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npm test tests/schema.test.ts
```

Expected: PASS. (Note: every future migration is applied to `erp_test` the same way; add it to the task's migrate step.)

- [ ] **Step 4: Seed**

`erp/prisma/seed.ts`:

```ts
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { ALL_PERMISSIONS } from "../src/server/permissions";

const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.role.upsert({
    where: { name: "Admin" },
    update: {},
    create: { name: "Admin" },
  });
  for (const permission of ALL_PERMISSIONS) {
    await prisma.rolePermission.upsert({
      where: { roleId_permission: { roleId: admin.id, permission } },
      update: {},
      create: { roleId: admin.id, permission },
    });
  }
  await prisma.user.upsert({
    where: { username: "admin" },
    update: { roleId: admin.id },
    create: {
      username: "admin",
      displayName: "Administrator",
      passwordHash: await argon2.hash("admin"),
      roleId: admin.id,
    },
  });
  console.log("Seeded Admin role + admin user (password: admin — change it after first login).");
}

main().finally(() => prisma.$disconnect());
```

(`ALL_PERMISSIONS` arrives in Task 5; until then this file won't compile — that's fine, seeding runs after Task 5. Do not run `db:seed` yet.)

- [ ] **Step 5: Commit**

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "feat: core schema (users, sessions, roles, permissions, settings, audit) and seed"
```

---

### Task 3: Password and session services

**Files:**
- Create: `erp/src/server/password.ts`, `erp/src/server/sessions.ts`, `erp/src/server/context.ts`
- Test: `erp/tests/password.test.ts`, `erp/tests/sessions.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 1), `Session`/`User` models (Task 2).
- Produces:
  - `hashPassword(plain: string): Promise<string>`; `verifyPassword(hash: string, plain: string): Promise<boolean>`
  - `createSession(userId: string): Promise<{ token: string; expiresAt: Date }>`
  - `getSessionUser(token: string): Promise<(User & { role: (Role & { permissions: RolePermission[] }) | null; overrides: UserPermissionOverride[] }) | null>` — also slides expiry
  - `destroySession(token: string): Promise<void>`
  - `SESSION_TIMEOUT_FALLBACK_MINUTES = 480` (real value read from settings once Task 10 lands — see note in Step 4)
  - `context.ts`: `runWithActor<T>(actor: { id: string | null; name: string }, fn: () => Promise<T>): Promise<T>` and `currentActor(): { id: string | null; name: string }` (defaults to `{ id: null, name: "system" }`)

- [ ] **Step 1: Failing password test**

`erp/tests/password.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/server/password";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword(hash, "correct horse")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });
});
```

Run: `npm test tests/password.test.ts` — expected: FAIL (module missing).

- [ ] **Step 2: Implement password.ts**

```ts
import argon2 from "argon2";

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
```

Run: `npm test tests/password.test.ts` — expected: PASS.

- [ ] **Step 3: Failing session tests**

`erp/tests/sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { createSession, getSessionUser, destroySession } from "@/server/sessions";

async function makeUser(username = "jane") {
  return prisma.user.create({
    data: { username, passwordHash: "x", displayName: username },
  });
}

describe("sessions", () => {
  beforeEach(async () => await truncateAll());

  it("round-trips a session token to its user", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    const found = await getSessionUser(token);
    expect(found?.id).toBe(user.id);
  });

  it("stores only a hash of the token", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    const rows = await prisma.session.findMany();
    expect(rows[0].tokenHash).not.toBe(token);
  });

  it("rejects expired sessions", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await getSessionUser(token)).toBeNull();
  });

  it("rejects disabled users", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    expect(await getSessionUser(token)).toBeNull();
  });

  it("destroySession invalidates the token", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await destroySession(token);
    expect(await getSessionUser(token)).toBeNull();
  });
});
```

Run: `npm test tests/sessions.test.ts` — expected: FAIL (module missing).

- [ ] **Step 4: Implement sessions.ts and context.ts**

`erp/src/server/sessions.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";

export const SESSION_TIMEOUT_FALLBACK_MINUTES = 480;
// NOTE (Task 10): once settings.ts exists, replace timeoutMinutes() body with
// getSetting("session_timeout_minutes") — Task 10 Step 5 does exactly that.
async function timeoutMinutes(): Promise<number> {
  return SESSION_TIMEOUT_FALLBACK_MINUTES;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + (await timeoutMinutes()) * 60_000);
  await prisma.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt } });
  return { token, expiresAt };
}

export async function getSessionUser(token: string) {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: { include: { role: { include: { permissions: true } }, overrides: true } },
    },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) return null;
  if (!session.user.active || session.user.deletedAt) return null;
  // Sliding expiry
  const expiresAt = new Date(Date.now() + (await timeoutMinutes()) * 60_000);
  await prisma.session.update({ where: { id: session.id }, data: { expiresAt } });
  return session.user;
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}
```

`erp/src/server/context.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";

export type Actor = { id: string | null; name: string };

const storage = new AsyncLocalStorage<Actor>();

export function runWithActor<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
  return storage.run(actor, fn);
}

export function currentActor(): Actor {
  return storage.getStore() ?? { id: null, name: "system" };
}
```

Run: `npm test tests/sessions.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "feat: argon2 passwords, hashed session tokens with sliding expiry, actor context"
```

---

### Task 4: Login/logout routes, login page, request guard

**Files:**
- Create: `erp/src/server/http.ts`, `erp/src/app/api/auth/login/route.ts`, `erp/src/app/api/auth/logout/route.ts`, `erp/src/app/login/page.tsx`, `erp/src/lib/fetcher.ts`
- Test: `erp/tests/auth-routes.test.ts`

**Interfaces:**
- Consumes: `verifyPassword`, `createSession`, `getSessionUser`, `destroySession` (Task 3).
- Produces:
  - `http.ts`: `SESSION_COOKIE = "erp_session"`; `requireUser(req: Request): Promise<SessionUser>` (throws `HttpError(401)` when absent); `class HttpError extends Error { constructor(public status: number, message: string) }`; `handle(fn): (req, ctx) => Promise<NextResponse>` wrapper that converts `HttpError` to a JSON response and runs `fn` inside `runWithActor`.
  - `SessionUser` type alias = return type of `getSessionUser` non-null.
  - `POST /api/auth/login` body `{ username, password }` → sets cookie, returns `{ ok: true, displayName }`; 401 `{ error: "Invalid username or password" }` on failure (same message for unknown user vs wrong password).
  - `POST /api/auth/logout` → clears cookie.

- [ ] **Step 1: Failing route tests**

`erp/tests/auth-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";

function jsonReq(url: string, body: unknown, cookie?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe("auth routes", () => {
  beforeEach(async () => {
    await truncateAll();
    await prisma.user.create({
      data: { username: "admin", displayName: "Admin", passwordHash: await hashPassword("secret1") },
    });
  });

  it("logs in with correct credentials and sets the session cookie", async () => {
    const res = await login(jsonReq("http://t/api/auth/login", { username: "admin", password: "secret1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("erp_session=");
  });

  it("rejects bad credentials with a generic message", async () => {
    const res = await login(jsonReq("http://t/api/auth/login", { username: "admin", password: "nope" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid username or password");
  });

  it("logout clears the cookie", async () => {
    const loginRes = await login(jsonReq("http://t/api/auth/login", { username: "admin", password: "secret1" }));
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];
    const res = await logout(jsonReq("http://t/api/auth/logout", {}, cookie));
    expect(res.headers.get("set-cookie")).toContain("erp_session=;");
  });
});
```

Run: `npm test tests/auth-routes.test.ts` — expected: FAIL (routes missing).

- [ ] **Step 2: Implement http.ts**

```ts
import { NextResponse } from "next/server";
import { getSessionUser } from "./sessions";
import { runWithActor } from "./context";

export const SESSION_COOKIE = "erp_session";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

export function cookieToken(req: Request): string | null {
  const header = req.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

export async function requireUser(req: Request): Promise<SessionUser> {
  const token = cookieToken(req);
  const user = token ? await getSessionUser(token) : null;
  if (!user) throw new HttpError(401, "Not signed in");
  return user;
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<NextResponse>;
// ctx REQUIRED: Next 15's generated ParamCheck rejects `ctx?` (undefined not assignable to RouteContext).
// Tests therefore always pass a ctx: `TEST_CTX = { params: Promise.resolve({}) }`.

/** Wraps a route handler: catches HttpError, and if a session exists, runs inside the actor context. */
export function handle(fn: Handler): Handler {
  return async (req, ctx) => {
    const token = cookieToken(req);
    const user = token ? await getSessionUser(token) : null;
    const actor = user ? { id: user.id, name: user.displayName } : { id: null, name: "anonymous" };
    try {
      return await runWithActor(actor, () => fn(req, ctx));
    } catch (err) {
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  };
}
```

- [ ] **Step 3: Implement login/logout routes**

`erp/src/app/api/auth/login/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/server/db";
import { verifyPassword } from "@/server/password";
import { createSession } from "@/server/sessions";
import { SESSION_COOKIE, handle } from "@/server/http";

const Body = z.object({ username: z.string().min(1), password: z.string().min(1) });

export const POST = handle(async (req) => {
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { username: body.data.username } });
  const ok = user && user.active && !user.deletedAt && (await verifyPassword(user.passwordHash, body.data.password));
  if (!ok) return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  const { token, expiresAt } = await createSession(user.id);
  const res = NextResponse.json({ ok: true, displayName: user.displayName });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  return res;
});
```

`erp/src/app/api/auth/logout/route.ts`:

```ts
import { NextResponse } from "next/server";
import { destroySession } from "@/server/sessions";
import { SESSION_COOKIE, cookieToken, handle } from "@/server/http";

export const POST = handle(async (req) => {
  const token = cookieToken(req);
  if (token) await destroySession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
});
```

Run: `npm test tests/auth-routes.test.ts` — expected: PASS.

- [ ] **Step 4: Login page and client fetch helper**

`erp/src/lib/fetcher.ts`:

```ts
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}
```

`erp/src/app/login/page.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100">
      <form onSubmit={submit} className="w-80 rounded-lg bg-white p-6 shadow">
        <h1 className="mb-4 text-xl font-semibold">Sign in</h1>
        <label className="mb-2 block text-sm">
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus
            className="mt-1 w-full rounded border px-2 py-1" />
        </label>
        <label className="mb-4 block text-sm">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border px-2 py-1" />
        </label>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <button className="w-full rounded bg-slate-800 py-2 text-white">Sign in</button>
      </form>
    </main>
  );
}
```

Manual check: `npm run dev`, open `http://localhost:3000/login`, wrong password shows the generic error. (Login succeeds only after seeding — Task 5.)

- [ ] **Step 5: Commit**

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "feat: login/logout routes, request guard with actor context, login page"
```

---

### Task 5: Permission engine

**Files:**
- Create: `erp/src/server/permissions.ts`
- Test: `erp/tests/permissions.test.ts`

**Interfaces:**
- Consumes: `SessionUser` shape (Task 4) — user with `role.permissions[]` and `overrides[]` loaded.
- Produces (exact, used by every later phase):
  - `AREAS = ["orders","parts","processes","customers","quotes","certs","shipping","invoicing","ar","reports","templates","admin"] as const`
  - `CRUD_ACTIONS = ["view","create","edit","delete"] as const`
  - `SPECIAL_ACTIONS = ["void_shipper","unlock_invoice","void_order","change_prices","edit_cert_results_after_print","apply_payments","run_qbo_export","close_ar_period","edit_templates","manage_users"] as const`
  - `type Area`, `type CrudAction`, `type SpecialAction` (derived)
  - `ALL_PERMISSIONS: string[]` — every `"{area}.{action}"` plus every `"action.{special}"`
  - `can(user: PermUser, area: Area, action: CrudAction): boolean`
  - `canDo(user: PermUser, special: SpecialAction): boolean`
  - `type PermUser = { role: { permissions: { permission: string }[] } | null; overrides: { permission: string; mode: "GRANT" | "DENY" }[] }`
  - Resolution rule (spec §9): **DENY override > GRANT override > role grant > deny by default.**

- [ ] **Step 1: Failing tests**

`erp/tests/permissions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { can, canDo, ALL_PERMISSIONS, type PermUser } from "@/server/permissions";

function user(rolePerms: string[], overrides: { permission: string; mode: "GRANT" | "DENY" }[] = []): PermUser {
  return { role: { permissions: rolePerms.map((permission) => ({ permission })) }, overrides };
}

describe("permission resolution", () => {
  it("denies by default", () => {
    expect(can(user([]), "orders", "view")).toBe(false);
    expect(canDo(user([]), "void_shipper")).toBe(false);
  });

  it("role grants work", () => {
    expect(can(user(["orders.view"]), "orders", "view")).toBe(true);
    expect(canDo(user(["action.void_shipper"]), "void_shipper")).toBe(true);
  });

  it("GRANT override adds to a role", () => {
    expect(can(user([], [{ permission: "invoicing.edit", mode: "GRANT" }]), "invoicing", "edit")).toBe(true);
  });

  it("DENY override beats a role grant", () => {
    expect(can(user(["orders.delete"], [{ permission: "orders.delete", mode: "DENY" }]), "orders", "delete")).toBe(false);
  });

  it("DENY beats GRANT when both exist", () => {
    const u = user([], [
      { permission: "ar.view", mode: "GRANT" },
      { permission: "ar.view", mode: "DENY" },
    ]);
    expect(can(u, "ar", "view")).toBe(false);
  });

  it("no role means only overrides apply", () => {
    const u: PermUser = { role: null, overrides: [{ permission: "reports.view", mode: "GRANT" }] };
    expect(can(u, "reports", "view")).toBe(true);
    expect(can(u, "orders", "view")).toBe(false);
  });

  it("ALL_PERMISSIONS covers areas × actions plus specials", () => {
    expect(ALL_PERMISSIONS).toContain("orders.view");
    expect(ALL_PERMISSIONS).toContain("action.close_ar_period");
    expect(ALL_PERMISSIONS.length).toBe(12 * 4 + 10);
  });
});
```

Run: `npm test tests/permissions.test.ts` — expected: FAIL.

- [ ] **Step 2: Implement permissions.ts**

```ts
export const AREAS = [
  "orders", "parts", "processes", "customers", "quotes", "certs",
  "shipping", "invoicing", "ar", "reports", "templates", "admin",
] as const;
export const CRUD_ACTIONS = ["view", "create", "edit", "delete"] as const;
export const SPECIAL_ACTIONS = [
  "void_shipper", "unlock_invoice", "void_order", "change_prices",
  "edit_cert_results_after_print", "apply_payments", "run_qbo_export",
  "close_ar_period", "edit_templates", "manage_users",
] as const;

export type Area = (typeof AREAS)[number];
export type CrudAction = (typeof CRUD_ACTIONS)[number];
export type SpecialAction = (typeof SPECIAL_ACTIONS)[number];

export const ALL_PERMISSIONS: string[] = [
  ...AREAS.flatMap((a) => CRUD_ACTIONS.map((c) => `${a}.${c}`)),
  ...SPECIAL_ACTIONS.map((s) => `action.${s}`),
];

export type PermUser = {
  role: { permissions: { permission: string }[] } | null;
  overrides: { permission: string; mode: "GRANT" | "DENY" }[] ;
};

function resolve(user: PermUser, key: string): boolean {
  if (user.overrides.some((o) => o.permission === key && o.mode === "DENY")) return false;
  if (user.overrides.some((o) => o.permission === key && o.mode === "GRANT")) return true;
  return user.role?.permissions.some((p) => p.permission === key) ?? false;
}

export function can(user: PermUser, area: Area, action: CrudAction): boolean {
  return resolve(user, `${area}.${action}`);
}

export function canDo(user: PermUser, special: SpecialAction): boolean {
  return resolve(user, `action.${special}`);
}

/** Throw-on-deny helpers for route handlers. */
import { HttpError } from "./http";
export function mustCan(user: PermUser, area: Area, action: CrudAction): void {
  if (!can(user, area, action)) throw new HttpError(403, "You do not have permission for that");
}
export function mustDo(user: PermUser, special: SpecialAction): void {
  if (!canDo(user, special)) throw new HttpError(403, "You do not have permission for that");
}
```

Run: `npm test tests/permissions.test.ts` — expected: PASS.

- [ ] **Step 3: Seed now compiles — run it and log in manually**

```bash
npm run db:seed
```

Expected output: `Seeded Admin role + admin user (password: admin — change it after first login).`
Manual check: `npm run dev` → log in as `admin`/`admin` at `/login` → redirected to `/`.

- [ ] **Step 4: Commit**

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "feat: permission engine (areas, CRUD, special actions, DENY>GRANT>role resolution)"
```

---

### Task 6: Roles service and roles admin page

**Files:**
- Create: `erp/src/server/roles.ts`, `erp/src/app/api/admin/roles/route.ts`, `erp/src/app/api/admin/roles/[id]/route.ts`, `erp/src/app/admin/roles/page.tsx`
- Test: `erp/tests/roles.test.ts`

**Interfaces:**
- Consumes: `prisma`, `mustCan` (admin.view / admin.edit), `requireUser`, `handle`, `ALL_PERMISSIONS`.
- Produces (service, used by users task and later phases):
  - `listRoles(): Promise<Array<{ id: string; name: string; permissions: string[]; userCount: number }>>`
  - `createRole(name: string): Promise<{ id: string }>` — rejects duplicate names (`HttpError(400)`)
  - `setRolePermissions(roleId: string, permissions: string[]): Promise<void>` — replaces the set; rejects unknown permission keys (`HttpError(400)`)
  - `renameRole(roleId: string, name: string): Promise<void>`
  - `deleteRole(roleId: string): Promise<void>` — soft delete; rejects when users still hold it (`HttpError(400, "Role is assigned to users")`)
  - HTTP: `GET/POST /api/admin/roles`; `PUT/DELETE /api/admin/roles/[id]` (PUT body `{ name?, permissions? }`)
- NOTE: role mutations write plain prisma here; Task 8 migrates them onto audit helpers (its Step 4 lists the exact call sites).

- [ ] **Step 1: Failing service tests**

`erp/tests/roles.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { createRole, listRoles, setRolePermissions, deleteRole, renameRole } from "@/server/roles";
import { HttpError } from "@/server/http";

describe("roles service", () => {
  beforeEach(async () => await truncateAll());

  it("creates, lists, and renames roles", async () => {
    const { id } = await createRole("Office");
    await renameRole(id, "Front Office");
    const roles = await listRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ name: "Front Office", permissions: [], userCount: 0 });
  });

  it("rejects duplicate names", async () => {
    await createRole("Office");
    await expect(createRole("Office")).rejects.toThrow(HttpError);
  });

  it("replaces the permission set and rejects unknown keys", async () => {
    const { id } = await createRole("Billing");
    await setRolePermissions(id, ["invoicing.view", "invoicing.edit"]);
    await setRolePermissions(id, ["invoicing.view"]);
    expect((await listRoles())[0].permissions).toEqual(["invoicing.view"]);
    await expect(setRolePermissions(id, ["nope.bogus"])).rejects.toThrow(HttpError);
  });

  it("refuses to delete a role users still hold, allows otherwise", async () => {
    const { id } = await createRole("Office");
    await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "J", roleId: id } });
    await expect(deleteRole(id)).rejects.toThrow("Role is assigned to users");
    await prisma.user.updateMany({ data: { roleId: null } });
    await deleteRole(id);
    expect(await listRoles()).toHaveLength(0);
  });
});
```

Run: `npm test tests/roles.test.ts` — expected: FAIL.

- [ ] **Step 2: Implement roles.ts**

```ts
import { prisma } from "./db";
import { HttpError } from "./http";
import { ALL_PERMISSIONS } from "./permissions";

export async function listRoles() {
  const roles = await prisma.role.findMany({
    where: { deletedAt: null },
    include: { permissions: true, _count: { select: { users: { where: { deletedAt: null } } } } },
    orderBy: { name: "asc" },
  });
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    permissions: r.permissions.map((p) => p.permission).sort(),
    userCount: r._count.users,
  }));
}

export async function createRole(name: string): Promise<{ id: string }> {
  const existing = await prisma.role.findUnique({ where: { name } });
  if (existing && !existing.deletedAt) throw new HttpError(400, "A role with that name already exists");
  const role = existing
    ? await prisma.role.update({ where: { id: existing.id }, data: { deletedAt: null } })
    : await prisma.role.create({ data: { name } });
  return { id: role.id };
}

export async function renameRole(roleId: string, name: string): Promise<void> {
  await prisma.role.update({ where: { id: roleId }, data: { name } });
}

export async function setRolePermissions(roleId: string, permissions: string[]): Promise<void> {
  const unknown = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
  if (unknown.length) throw new HttpError(400, `Unknown permissions: ${unknown.join(", ")}`);
  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { roleId } }),
    prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permission })) }),
  ]);
}

export async function deleteRole(roleId: string): Promise<void> {
  const holders = await prisma.user.count({ where: { roleId, deletedAt: null } });
  if (holders > 0) throw new HttpError(400, "Role is assigned to users");
  await prisma.role.update({ where: { id: roleId }, data: { deletedAt: new Date() } });
}
```

Run: `npm test tests/roles.test.ts` — expected: PASS.

- [ ] **Step 3: Routes**

`erp/src/app/api/admin/roles/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { listRoles, createRole } from "@/server/roles";

export const GET = handle(async (req) => {
  mustCan(await requireUser(req), "admin", "view");
  return NextResponse.json(await listRoles());
});

export const POST = handle(async (req) => {
  mustCan(await requireUser(req), "admin", "edit");
  const { name } = z.object({ name: z.string().min(1) }).parse(await req.json());
  return NextResponse.json(await createRole(name));
});
```

`erp/src/app/api/admin/roles/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { renameRole, setRolePermissions, deleteRole } from "@/server/roles";

const Body = z.object({ name: z.string().min(1).optional(), permissions: z.array(z.string()).optional() });

export const PUT = handle(async (req, ctx) => {
  mustCan(await requireUser(req), "admin", "edit");
  const { id } = await ctx!.params; // Next.js always supplies ctx for dynamic routes
  const body = Body.parse(await req.json());
  if (body.name) await renameRole(id, body.name);
  if (body.permissions) await setRolePermissions(id, body.permissions);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (req, ctx) => {
  mustCan(await requireUser(req), "admin", "edit");
  const { id } = await ctx!.params; // Next.js always supplies ctx for dynamic routes
  await deleteRole(id);
  return NextResponse.json({ ok: true });
});
```

- [ ] **Step 4: Roles page (permission grid)**

`erp/src/app/admin/roles/page.tsx`:

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { AREAS, CRUD_ACTIONS, SPECIAL_ACTIONS } from "@/server/permissions";

type Role = { id: string; name: string; permissions: string[]; userCount: number };

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [selected, setSelected] = useState<Role | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<Role[]>("/api/admin/roles");
    setRoles(data);
    setSelected((cur) => (cur ? data.find((r) => r.id === cur.id) ?? null : null));
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function create() {
    try { await api("/api/admin/roles", { method: "POST", body: JSON.stringify({ name: newName }) });
      setNewName(""); await load(); } catch (e) { setError((e as Error).message); }
  }

  async function toggle(permission: string) {
    if (!selected) return;
    const has = selected.permissions.includes(permission);
    const next = has ? selected.permissions.filter((p) => p !== permission) : [...selected.permissions, permission];
    try { await api(`/api/admin/roles/${selected.id}`, { method: "PUT", body: JSON.stringify({ permissions: next }) });
      await load(); } catch (e) { setError((e as Error).message); }
  }

  async function remove(role: Role) {
    if (!confirm(`Delete role "${role.name}"?`)) return;
    try { await api(`/api/admin/roles/${role.id}`, { method: "DELETE" }); setSelected(null); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Roles</h1>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="flex gap-6">
        <div className="w-64">
          <ul className="mb-3 divide-y rounded border bg-white">
            {roles.map((r) => (
              <li key={r.id}
                  className={`flex cursor-pointer items-center justify-between px-3 py-2 ${selected?.id === r.id ? "bg-slate-100" : ""}`}
                  onClick={() => setSelected(r)}>
                <span>{r.name} <span className="text-xs text-slate-500">({r.userCount})</span></span>
                <button onClick={(e) => { e.stopPropagation(); void remove(r); }}
                        className="text-xs text-red-600">delete</button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New role name"
                   className="w-full rounded border px-2 py-1 text-sm" />
            <button onClick={create} className="rounded bg-slate-800 px-3 py-1 text-sm text-white">Add</button>
          </div>
        </div>
        {selected && (
          <div className="flex-1 rounded border bg-white p-4">
            <h2 className="mb-3 font-medium">{selected.name} — permissions</h2>
            <table className="mb-4 w-full text-sm">
              <thead><tr><th className="text-left">Area</th>
                {CRUD_ACTIONS.map((a) => <th key={a} className="px-2 capitalize">{a}</th>)}</tr></thead>
              <tbody>
                {AREAS.map((area) => (
                  <tr key={area} className="border-t">
                    <td className="py-1 capitalize">{area}</td>
                    {CRUD_ACTIONS.map((action) => {
                      const key = `${area}.${action}`;
                      return (
                        <td key={key} className="px-2 text-center">
                          <input type="checkbox" checked={selected.permissions.includes(key)}
                                 onChange={() => toggle(key)} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <h3 className="mb-2 font-medium">Special actions</h3>
            <div className="grid grid-cols-2 gap-1 text-sm">
              {SPECIAL_ACTIONS.map((s) => {
                const key = `action.${s}`;
                return (
                  <label key={key} className="flex items-center gap-2">
                    <input type="checkbox" checked={selected.permissions.includes(key)} onChange={() => toggle(key)} />
                    {s.replaceAll("_", " ")}
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

Manual check: as admin, `/admin/roles` — create "Office", tick orders view/create/edit, refresh, ticks persist.

- [ ] **Step 5: Commit**

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "feat: roles service, routes, and permission-grid admin page"
```

---

### Task 7: Users service and users admin page

**Files:**
- Create: `erp/src/server/users.ts`, `erp/src/app/api/admin/users/route.ts`, `erp/src/app/api/admin/users/[id]/route.ts`, `erp/src/app/admin/users/page.tsx`
- Test: `erp/tests/users.test.ts`

**Interfaces:**
- Consumes: `hashPassword` (Task 3), `mustDo(user, "manage_users")` (Task 5), roles list (Task 6).
- Produces:
  - `listUsers(): Promise<Array<{ id; username; displayName; roleName: string | null; active: boolean; overrides: { permission: string; mode: "GRANT" | "DENY" }[] }>>`
  - `createUser(input: { username: string; displayName: string; password: string; roleId?: string }): Promise<{ id: string }>` — duplicate username → `HttpError(400)`
  - `updateUser(id, input: { displayName?: string; roleId?: string | null; active?: boolean; password?: string }): Promise<void>`
  - `setUserOverrides(id, overrides: { permission: string; mode: "GRANT" | "DENY" }[]): Promise<void>` — validates keys against `ALL_PERMISSIONS`
  - Users are never hard-deleted (spec §9): deactivate via `active: false`.
  - HTTP: `GET/POST /api/admin/users`; `PUT /api/admin/users/[id]` (no DELETE route — deactivation only).

- [ ] **Step 1: Failing service tests**

`erp/tests/users.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { createUser, listUsers, updateUser, setUserOverrides } from "@/server/users";
import { createRole } from "@/server/roles";
import { verifyPassword } from "@/server/password";
import { prisma } from "./helpers/db";
import { HttpError } from "@/server/http";

describe("users service", () => {
  beforeEach(async () => await truncateAll());

  it("creates a user with a hashed password and lists it", async () => {
    const { id } = await createUser({ username: "jane", displayName: "Jane", password: "pw12345" });
    const row = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(row.passwordHash).not.toBe("pw12345");
    expect(await verifyPassword(row.passwordHash, "pw12345")).toBe(true);
    expect((await listUsers())[0]).toMatchObject({ username: "jane", roleName: null, active: true });
  });

  it("rejects duplicate usernames", async () => {
    await createUser({ username: "jane", displayName: "J", password: "x1234567" });
    await expect(createUser({ username: "jane", displayName: "K", password: "y1234567" }))
      .rejects.toThrow(HttpError);
  });

  it("assigns roles, deactivates, resets password", async () => {
    const role = await createRole("Office");
    const { id } = await createUser({ username: "jane", displayName: "Jane", password: "pw12345" });
    await updateUser(id, { roleId: role.id, active: false, password: "newpw999" });
    const listed = (await listUsers())[0];
    expect(listed.roleName).toBe("Office");
    expect(listed.active).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(await verifyPassword(row.passwordHash, "newpw999")).toBe(true);
  });

  it("replaces overrides and validates keys", async () => {
    const { id } = await createUser({ username: "jane", displayName: "Jane", password: "pw12345" });
    await setUserOverrides(id, [{ permission: "orders.view", mode: "GRANT" }]);
    await setUserOverrides(id, [{ permission: "orders.view", mode: "DENY" }]);
    expect((await listUsers())[0].overrides).toEqual([{ permission: "orders.view", mode: "DENY" }]);
    await expect(setUserOverrides(id, [{ permission: "bogus.key", mode: "GRANT" }])).rejects.toThrow(HttpError);
  });
});
```

Run: `npm test tests/users.test.ts` — expected: FAIL.

- [ ] **Step 2: Implement users.ts**

```ts
import { prisma } from "./db";
import { HttpError } from "./http";
import { hashPassword } from "./password";
import { ALL_PERMISSIONS } from "./permissions";

export async function listUsers() {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    include: { role: true, overrides: true },
    orderBy: { username: "asc" },
  });
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    roleName: u.role?.name ?? null,
    roleId: u.roleId,
    active: u.active,
    overrides: u.overrides.map((o) => ({ permission: o.permission, mode: o.mode })),
  }));
}

export async function createUser(input: { username: string; displayName: string; password: string; roleId?: string }) {
  const dupe = await prisma.user.findUnique({ where: { username: input.username } });
  if (dupe) throw new HttpError(400, "That username is taken");
  const user = await prisma.user.create({
    data: {
      username: input.username,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      roleId: input.roleId ?? null,
    },
  });
  return { id: user.id };
}

export async function updateUser(
  id: string,
  input: { displayName?: string; roleId?: string | null; active?: boolean; password?: string },
) {
  await prisma.user.update({
    where: { id },
    data: {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
    },
  });
}

export async function setUserOverrides(id: string, overrides: { permission: string; mode: "GRANT" | "DENY" }[]) {
  const unknown = overrides.filter((o) => !ALL_PERMISSIONS.includes(o.permission));
  if (unknown.length) throw new HttpError(400, `Unknown permissions: ${unknown.map((o) => o.permission).join(", ")}`);
  await prisma.$transaction([
    prisma.userPermissionOverride.deleteMany({ where: { userId: id } }),
    prisma.userPermissionOverride.createMany({
      data: overrides.map((o) => ({ userId: id, permission: o.permission, mode: o.mode })),
    }),
  ]);
}
```

Run: `npm test tests/users.test.ts` — expected: PASS.

- [ ] **Step 3: Routes**

`erp/src/app/api/admin/users/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { listUsers, createUser } from "@/server/users";

export const GET = handle(async (req) => {
  mustDo(await requireUser(req), "manage_users");
  return NextResponse.json(await listUsers());
});

const CreateBody = z.object({
  username: z.string().min(1),
  displayName: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters"),
  roleId: z.string().optional(),
});

export const POST = handle(async (req) => {
  mustDo(await requireUser(req), "manage_users");
  return NextResponse.json(await createUser(CreateBody.parse(await req.json())));
});
```

`erp/src/app/api/admin/users/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustDo } from "@/server/permissions";
import { updateUser, setUserOverrides } from "@/server/users";

const Body = z.object({
  displayName: z.string().min(1).optional(),
  roleId: z.string().nullable().optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).optional(),
  overrides: z.array(z.object({ permission: z.string(), mode: z.enum(["GRANT", "DENY"]) })).optional(),
});

export const PUT = handle(async (req, ctx) => {
  mustDo(await requireUser(req), "manage_users");
  const { id } = await ctx!.params; // Next.js always supplies ctx for dynamic routes
  const body = Body.parse(await req.json());
  const { overrides, ...rest } = body;
  if (Object.keys(rest).length) await updateUser(id, rest);
  if (overrides) await setUserOverrides(id, overrides);
  return NextResponse.json({ ok: true });
});
```

- [ ] **Step 4: Users page**

`erp/src/app/admin/users/page.tsx`:

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";

type Role = { id: string; name: string };
type User = {
  id: string; username: string; displayName: string; roleId: string | null;
  roleName: string | null; active: boolean;
  overrides: { permission: string; mode: "GRANT" | "DENY" }[];
};

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", roleId: "" });

  const load = useCallback(async () => {
    setUsers(await api<User[]>("/api/admin/users"));
    setRoles(await api<Role[]>("/api/admin/roles"));
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function create() {
    try {
      await api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ ...form, roleId: form.roleId || undefined }),
      });
      setForm({ username: "", displayName: "", password: "", roleId: "" });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function patch(id: string, body: object) {
    try { await api(`/api/admin/users/${id}`, { method: "PUT", body: JSON.stringify(body) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Users</h1>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <table className="mb-6 w-full rounded border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">Username</th><th className="p-2">Name</th><th className="p-2">Role</th>
          <th className="p-2">Active</th><th className="p-2">Reset password</th>
        </tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b">
              <td className="p-2">{u.username}</td>
              <td className="p-2">{u.displayName}</td>
              <td className="p-2">
                <select value={u.roleId ?? ""} onChange={(e) => patch(u.id, { roleId: e.target.value || null })}
                        className="rounded border px-1 py-0.5">
                  <option value="">— none —</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </td>
              <td className="p-2">
                <input type="checkbox" checked={u.active} onChange={(e) => patch(u.id, { active: e.target.checked })} />
              </td>
              <td className="p-2">
                <button className="text-blue-700 underline"
                        onClick={() => { const p = prompt("New password (min 8 chars):"); if (p) void patch(u.id, { password: p }); }}>
                  reset…
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="mb-2 font-medium">Add user</h2>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <input placeholder="Username" value={form.username}
               onChange={(e) => setForm({ ...form, username: e.target.value })} className="rounded border px-2 py-1" />
        <input placeholder="Display name" value={form.displayName}
               onChange={(e) => setForm({ ...form, displayName: e.target.value })} className="rounded border px-2 py-1" />
        <input placeholder="Password" type="password" value={form.password}
               onChange={(e) => setForm({ ...form, password: e.target.value })} className="rounded border px-2 py-1" />
        <select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}
                className="rounded border px-2 py-1">
          <option value="">— no role —</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button onClick={create} className="rounded bg-slate-800 px-3 py-1 text-white">Add</button>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Users are never deleted — deactivate instead (audit history must keep resolving their names).
        Per-user permission overrides are edited from the user's History panel in a later phase; the API already supports them.
      </p>
    </div>
  );
}
```

Manual check: create user "jane", assign Office role, deactivate/reactivate, reset password, log in as jane in a private window.

- [ ] **Step 5: Commit**

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "feat: users service, routes, and admin page (no hard delete)"
```

---

### Task 8: Audit helpers — and route existing mutations through them

**Files:**
- Create: `erp/src/server/audit.ts`
- Modify: `erp/src/server/users.ts`, `erp/src/server/roles.ts` (switch mutations to helpers)
- Test: `erp/tests/audit.test.ts`

**Interfaces:**
- Consumes: `currentActor()` (Task 3), `prisma`.
- Produces (exact — every later phase uses these):
  - `type AuditableModel = "user" | "role" | "setting"` — **extended by each later phase** (add model names as they appear; keep the union in this one place)
  - `auditedCreate<T>(model: AuditableModel, data: object, doIt: () => Promise<T & { id: string }>): Promise<T & { id: string }>` — runs `doIt`, then logs `{ action: "create", after: data }`
  - `auditedUpdate<T>(model: AuditableModel, id: string, doIt: () => Promise<T>, opts?: { reason?: string }): Promise<T>` — snapshots the row before via `prisma[model].findUnique`, runs `doIt`, snapshots after, logs both
  - `auditedSoftDelete(model: AuditableModel, id: string, reason?: string): Promise<void>` — sets `deletedAt`, logs `{ action: "delete", before }`
  - `readAudit(entity: string, entityId: string): Promise<AuditLog[]>` (newest first)
  - `searchAudit(filter: { entity?: string; actorName?: string; from?: Date; to?: Date; limit?: number }): Promise<AuditLog[]>`
  - Actor fields are always filled from `currentActor()`. Passwords/hashes are redacted (`passwordHash` key replaced with `"[redacted]"` in snapshots).

- [ ] **Step 1: Failing tests**

`erp/tests/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithActor } from "@/server/context";
import { auditedCreate, auditedUpdate, auditedSoftDelete, readAudit, searchAudit } from "@/server/audit";

describe("audit helpers", () => {
  beforeEach(async () => await truncateAll());

  it("logs create with actor and redacts passwordHash", async () => {
    const user = await runWithActor({ id: "u0", name: "Admin" }, () =>
      auditedCreate("user", { username: "jane", passwordHash: "SECRET", displayName: "Jane" }, () =>
        prisma.user.create({ data: { username: "jane", passwordHash: "SECRET", displayName: "Jane" } }),
      ),
    );
    const log = await readAudit("user", user.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "create", actorName: "Admin", actorId: "u0" });
    expect(JSON.stringify(log[0].after)).not.toContain("SECRET");
  });

  it("logs update with before and after", async () => {
    const u = await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "Old" } });
    await auditedUpdate("user", u.id, () =>
      prisma.user.update({ where: { id: u.id }, data: { displayName: "New" } }),
    );
    const [entry] = await readAudit("user", u.id);
    expect((entry.before as { displayName: string }).displayName).toBe("Old");
    expect((entry.after as { displayName: string }).displayName).toBe("New");
  });

  it("soft delete sets deletedAt and logs with reason", async () => {
    const u = await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "J" } });
    await auditedSoftDelete("user", u.id, "left the company");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect((await readAudit("user", u.id))[0]).toMatchObject({ action: "delete", reason: "left the company" });
  });

  it("searchAudit filters by entity", async () => {
    const u = await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "J" } });
    await auditedUpdate("user", u.id, () =>
      prisma.user.update({ where: { id: u.id }, data: { displayName: "K" } }),
    );
    expect(await searchAudit({ entity: "user" })).toHaveLength(1);
    expect(await searchAudit({ entity: "role" })).toHaveLength(0);
  });
});
```

Run: `npm test tests/audit.test.ts` — expected: FAIL.

- [ ] **Step 2: Implement audit.ts**

```ts
import { prisma } from "./db";
import { currentActor } from "./context";
import type { Prisma } from "@prisma/client";

export type AuditableModel = "user" | "role" | "setting";

function redact(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const key of Object.keys(clone)) {
    if (key.toLowerCase().includes("passwordhash")) clone[key] = "[redacted]";
  }
  return clone as Prisma.InputJsonValue;
}

async function snapshot(model: AuditableModel, id: string): Promise<unknown> {
  // Each auditable model has a string id primary key named `id`.
  const client = prisma[model] as unknown as { findUnique: (a: { where: { id: string } }) => Promise<unknown> };
  return client.findUnique({ where: { id } });
}

async function write(entry: {
  entity: string; entityId: string; action: string;
  before?: unknown; after?: unknown; reason?: string;
}) {
  const actor = currentActor();
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      actorName: actor.name,
      entity: entry.entity,
      entityId: entry.entityId,
      action: entry.action,
      before: redact(entry.before),
      after: redact(entry.after),
      reason: entry.reason,
    },
  });
}

export async function auditedCreate<T extends { id: string }>(
  model: AuditableModel, data: object, doIt: () => Promise<T>,
): Promise<T> {
  const created = await doIt();
  await write({ entity: model, entityId: created.id, action: "create", after: data });
  return created;
}

export async function auditedUpdate<T>(
  model: AuditableModel, id: string, doIt: () => Promise<T>, opts?: { reason?: string },
): Promise<T> {
  const before = await snapshot(model, id);
  const result = await doIt();
  const after = await snapshot(model, id);
  await write({ entity: model, entityId: id, action: "update", before, after, reason: opts?.reason });
  return result;
}

export async function auditedSoftDelete(model: AuditableModel, id: string, reason?: string): Promise<void> {
  const before = await snapshot(model, id);
  const client = prisma[model] as unknown as {
    update: (a: { where: { id: string }; data: { deletedAt: Date } }) => Promise<unknown>;
  };
  await client.update({ where: { id }, data: { deletedAt: new Date() } });
  await write({ entity: model, entityId: id, action: "delete", before, reason });
}

export function readAudit(entity: string, entityId: string) {
  return prisma.auditLog.findMany({ where: { entity, entityId }, orderBy: { at: "desc" } });
}

export function searchAudit(filter: { entity?: string; actorName?: string; from?: Date; to?: Date; limit?: number }) {
  return prisma.auditLog.findMany({
    where: {
      ...(filter.entity ? { entity: filter.entity } : {}),
      ...(filter.actorName ? { actorName: { contains: filter.actorName, mode: "insensitive" } } : {}),
      ...(filter.from || filter.to ? { at: { gte: filter.from, lte: filter.to } } : {}),
    },
    orderBy: { at: "desc" },
    take: filter.limit ?? 200,
  });
}
```

Run: `npm test tests/audit.test.ts` — expected: PASS.

- [ ] **Step 3: Route existing mutations through the helpers**

In `erp/src/server/users.ts`: wrap the `prisma.user.create` call in `createUser` with `auditedCreate("user", {...input, passwordHash: "set"}, () => ...)`; wrap the `prisma.user.update` in `updateUser` with `auditedUpdate("user", id, () => ...)`; wrap `setUserOverrides`'s transaction with `auditedUpdate("user", id, () => ...)`.

In `erp/src/server/roles.ts`: wrap `createRole`'s create/update with `auditedCreate("role", { name }, ...)` / `auditedUpdate`; wrap `renameRole`, `setRolePermissions` with `auditedUpdate("role", roleId, ...)`; replace `deleteRole`'s update with `auditedSoftDelete("role", roleId)` (after the holders check).

Example (users.ts `updateUser` after the change):

```ts
import { auditedUpdate } from "./audit";
// ...
export async function updateUser(id: string, input: { /* unchanged */ }) {
  await auditedUpdate("user", id, () =>
    prisma.user.update({
      where: { id },
      data: { /* unchanged spread logic */ },
    }),
  );
}
```

- [ ] **Step 4: Extend tests to prove services audit**

Append to `erp/tests/users.test.ts`:

```ts
import { readAudit } from "@/server/audit";

it("user mutations write audit entries", async () => {
  const { id } = await createUser({ username: "audited", displayName: "A", password: "pw123456" });
  await updateUser(id, { displayName: "B" });
  const log = await readAudit("user", id);
  expect(log.map((l) => l.action)).toEqual(["update", "create"]);
});
```

Run: `npm test` — expected: ALL PASS (users, roles, audit, sessions, permissions, auth-routes, schema, health).

- [ ] **Step 5: Commit**

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "feat: audit helpers with redaction; users/roles mutations now audited"
```

---

### Task 9: History panel and admin audit log page

**Files:**
- Create: `erp/src/components/HistoryPanel.tsx`, `erp/src/app/api/admin/audit/route.ts`, `erp/src/app/admin/audit/page.tsx`
- Test: `erp/tests/admin-routes.test.ts` (audit route section)

**Interfaces:**
- Consumes: `readAudit`, `searchAudit` (Task 8), `mustCan(user, "admin", "view")`.
- Produces:
  - `GET /api/admin/audit?entity=&entityId=&actor=&from=&to=` → `AuditLog[]` (when `entityId` given uses `readAudit`, else `searchAudit`)
  - `<HistoryPanel entity="user" entityId={id} />` — client component every later phase drops onto its record pages; renders newest-first rows of `at / actorName / action / reason` with a diff of changed fields (keys whose before ≠ after).

- [ ] **Step 1: Failing route test**

Create `erp/tests/admin-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as auditGet } from "@/app/api/admin/audit/route";
import { auditedUpdate } from "@/server/audit";

async function adminCookie(): Promise<string> {
  const role = await prisma.role.create({
    data: { name: "Admin", permissions: { create: [{ permission: "admin.view" }, { permission: "admin.edit" }] } },
  });
  await prisma.user.create({
    data: { username: "root", displayName: "Root", passwordHash: await hashPassword("secret1"), roleId: role.id },
  });
  const res = await login(new Request("http://t/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "root", password: "secret1" }),
  }), { params: Promise.resolve({}) });
  return res.headers.get("set-cookie")!.split(";")[0];
}

function get(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

describe("audit route", () => {
  beforeEach(async () => await truncateAll());

  it("requires login", async () => {
    const res = await auditGet(get("http://t/api/admin/audit"), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it("returns entries filtered by entity/entityId", async () => {
    const cookie = await adminCookie();
    const u = await prisma.user.create({ data: { username: "j", passwordHash: "x", displayName: "J" } });
    await auditedUpdate("user", u.id, () =>
      prisma.user.update({ where: { id: u.id }, data: { displayName: "K" } }));
    const res = await auditGet(get(`http://t/api/admin/audit?entity=user&entityId=${u.id}`, cookie),
      { params: Promise.resolve({}) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].action).toBe("update");
  });
});
```

Run: `npm test tests/admin-routes.test.ts` — expected: FAIL.

- [ ] **Step 2: Implement the audit route**

`erp/src/app/api/admin/audit/route.ts`:

```ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { readAudit, searchAudit } from "@/server/audit";

export const GET = handle(async (req) => {
  mustCan(await requireUser(req), "admin", "view");
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity") ?? undefined;
  const entityId = url.searchParams.get("entityId") ?? undefined;
  if (entity && entityId) return NextResponse.json(await readAudit(entity, entityId));
  return NextResponse.json(await searchAudit({
    entity,
    actorName: url.searchParams.get("actor") ?? undefined,
    from: url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : undefined,
    to: url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : undefined,
  }));
});
```

Run: `npm test tests/admin-routes.test.ts` — expected: PASS.

- [ ] **Step 3: HistoryPanel component**

`erp/src/components/HistoryPanel.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";

type Entry = {
  id: string; at: string; actorName: string; action: string; reason: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
};

function changedFields(e: Entry): string[] {
  if (!e.before || !e.after) return [];
  const keys = new Set([...Object.keys(e.before), ...Object.keys(e.after)]);
  return [...keys].filter((k) => JSON.stringify(e.before?.[k]) !== JSON.stringify(e.after?.[k]))
    .filter((k) => !["updatedAt"].includes(k));
}

export function HistoryPanel({ entity, entityId }: { entity: string; entityId: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    api<Entry[]>(`/api/admin/audit?entity=${entity}&entityId=${entityId}`).then(setEntries).catch(() => {});
  }, [entity, entityId]);
  if (entries.length === 0) return <p className="text-sm text-slate-500">No history.</p>;
  return (
    <ul className="divide-y rounded border bg-white text-sm">
      {entries.map((e) => (
        <li key={e.id} className="p-2">
          <div className="flex justify-between">
            <span><b>{e.actorName}</b> — {e.action}{e.reason ? ` (${e.reason})` : ""}</span>
            <span className="text-slate-500">{new Date(e.at).toLocaleString()}</span>
          </div>
          {changedFields(e).map((k) => (
            <div key={k} className="ml-2 text-xs text-slate-600">
              {k}: <s>{JSON.stringify(e.before?.[k])}</s> → {JSON.stringify(e.after?.[k])}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Admin audit log page**

`erp/src/app/admin/audit/page.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";

type Entry = { id: string; at: string; actorName: string; entity: string; entityId: string; action: string; reason: string | null };

export default function AuditPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entity, setEntity] = useState("");
  const [actor, setActor] = useState("");

  async function load() {
    const params = new URLSearchParams();
    if (entity) params.set("entity", entity);
    if (actor) params.set("actor", actor);
    setEntries(await api<Entry[]>(`/api/admin/audit?${params}`));
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Audit log</h1>
      <div className="mb-3 flex gap-2 text-sm">
        <input placeholder="Entity (e.g. user)" value={entity} onChange={(e) => setEntity(e.target.value)}
               className="rounded border px-2 py-1" />
        <input placeholder="Actor name" value={actor} onChange={(e) => setActor(e.target.value)}
               className="rounded border px-2 py-1" />
        <button onClick={load} className="rounded bg-slate-800 px-3 py-1 text-white">Search</button>
      </div>
      <table className="w-full rounded border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">When</th><th className="p-2">Who</th><th className="p-2">Entity</th>
          <th className="p-2">Action</th><th className="p-2">Reason</th>
        </tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-b">
              <td className="p-2">{new Date(e.at).toLocaleString()}</td>
              <td className="p-2">{e.actorName}</td>
              <td className="p-2">{e.entity} <span className="text-xs text-slate-400">{e.entityId.slice(0, 8)}</span></td>
              <td className="p-2">{e.action}</td>
              <td className="p-2">{e.reason ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Manual check: edit a user, open `/admin/audit`, the update appears with your name.

- [ ] **Step 5: Commit**

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "feat: audit route, searchable admin log page, reusable HistoryPanel"
```

---

### Task 10: Typed settings framework and settings page

**Files:**
- Create: `erp/src/server/settings.ts`, `erp/src/app/api/admin/settings/route.ts`, `erp/src/app/admin/settings/page.tsx`
- Modify: `erp/src/server/sessions.ts` (read timeout from settings)
- Test: `erp/tests/settings.test.ts`

**Interfaces:**
- Consumes: `Setting` model, audit helpers, `mustCan(user, "admin", "edit")`.
- Produces (used by every later phase — numbering seeds and defaults live here):
  - `SETTINGS` registry: `Record<string, { schema: z.ZodType; default: unknown; label: string; group: "Company" | "Numbering" | "Dates" | "System" }>` with Phase 1 keys:
    `company_name` (string, ""), `company_address` (string, ""), `company_phone` (string, ""),
    `order_number_next` (int ≥ 1, 1000), `shipper_number_next` (int ≥ 1, 1000), `invoice_number_next` (int ≥ 1, 1000), `cert_number_next` (int ≥ 1, 1000), `quote_number_next` (int ≥ 1, 1000),
    `request_days_default` (int ≥ 0, 5), `traffic_may_miss_days` (int ≥ 0, 5), `traffic_will_miss_days` (int ≥ 0, 3),
    `session_timeout_minutes` (int 5–1440, 480)
  - `getSetting<K extends keyof typeof SETTINGS>(key: K): Promise<T>` — returns stored value or default; **validates on read**
  - `setSetting(key: string, value: unknown): Promise<void>` — zod-validates, audited (`entity: "setting", entityId: key`)
  - `allSettings(): Promise<Array<{ key; label; group; value }>>`
  - HTTP: `GET /api/admin/settings` (admin.view), `PUT /api/admin/settings` body `{ key, value }` (admin.edit)

- [ ] **Step 1: Failing tests**

`erp/tests/settings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { getSetting, setSetting, allSettings } from "@/server/settings";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/http";

describe("settings", () => {
  beforeEach(async () => await truncateAll());

  it("returns defaults when unset", async () => {
    expect(await getSetting("request_days_default")).toBe(5);
    expect(await getSetting("company_name")).toBe("");
  });

  it("stores, validates, and audits values", async () => {
    await setSetting("company_name", "Acme Heat Treating");
    expect(await getSetting("company_name")).toBe("Acme Heat Treating");
    await expect(setSetting("session_timeout_minutes", "not a number")).rejects.toThrow(HttpError);
    await expect(setSetting("bogus_key", 1)).rejects.toThrow(HttpError);
    expect((await readAudit("setting", "company_name"))[0].action).toBe("update");
  });

  it("lists every registered setting with group and label", async () => {
    const all = await allSettings();
    expect(all.find((s) => s.key === "order_number_next")).toMatchObject({ group: "Numbering", value: 1000 });
  });
});
```

Run: `npm test tests/settings.test.ts` — expected: FAIL.

- [ ] **Step 2: Implement settings.ts**

```ts
import { z } from "zod";
import { prisma } from "./db";
import { HttpError } from "./http";
import { currentActor } from "./context";

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.number().int().min(min).max(max);

export const SETTINGS = {
  company_name: { schema: z.string(), default: "", label: "Company name", group: "Company" },
  company_address: { schema: z.string(), default: "", label: "Company address", group: "Company" },
  company_phone: { schema: z.string(), default: "", label: "Company phone", group: "Company" },
  order_number_next: { schema: int(1), default: 1000, label: "Next order number", group: "Numbering" },
  shipper_number_next: { schema: int(1), default: 1000, label: "Next shipper number", group: "Numbering" },
  invoice_number_next: { schema: int(1), default: 1000, label: "Next invoice number", group: "Numbering" },
  cert_number_next: { schema: int(1), default: 1000, label: "Next certification number", group: "Numbering" },
  quote_number_next: { schema: int(1), default: 1000, label: "Next quote number", group: "Numbering" },
  request_days_default: { schema: int(0), default: 5, label: "Default request days", group: "Dates" },
  traffic_may_miss_days: { schema: int(0), default: 5, label: "May-miss window (days)", group: "Dates" },
  traffic_will_miss_days: { schema: int(0), default: 3, label: "Will-miss window (days)", group: "Dates" },
  session_timeout_minutes: { schema: int(5, 1440), default: 480, label: "Session timeout (minutes)", group: "System" },
} as const satisfies Record<string, { schema: z.ZodType; default: unknown; label: string; group: string }>;

export type SettingKey = keyof typeof SETTINGS;

export async function getSetting<K extends SettingKey>(key: K): Promise<z.infer<(typeof SETTINGS)[K]["schema"]>> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const def = SETTINGS[key];
  const raw = row ? row.value : def.default;
  const parsed = def.schema.safeParse(raw);
  return (parsed.success ? parsed.data : def.default) as z.infer<(typeof SETTINGS)[K]["schema"]>;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const def = SETTINGS[key as SettingKey];
  if (!def) throw new HttpError(400, `Unknown setting: ${key}`);
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, `Invalid value for ${key}: ${parsed.error.issues[0]?.message}`);
  const actor = currentActor();
  const before = await prisma.setting.findUnique({ where: { key } });
  await prisma.setting.upsert({
    where: { key },
    update: { value: parsed.data as object, updatedBy: actor.name },
    create: { key, value: parsed.data as object, updatedBy: actor.name },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.id, actorName: actor.name, entity: "setting", entityId: key, action: "update",
      before: before ? { value: before.value } : { value: def.default },
      after: { value: parsed.data },
    },
  });
}

export async function allSettings() {
  const rows = await prisma.setting.findMany();
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => ({
    key,
    label: SETTINGS[key].label,
    group: SETTINGS[key].group,
    value: stored.has(key) ? stored.get(key) : SETTINGS[key].default,
  }));
}
```

Run: `npm test tests/settings.test.ts` — expected: PASS.

- [ ] **Step 3: Sessions read the real timeout**

In `erp/src/server/sessions.ts`, replace the `timeoutMinutes` body:

```ts
import { getSetting } from "./settings";

async function timeoutMinutes(): Promise<number> {
  return getSetting("session_timeout_minutes");
}
```

(Keep `SESSION_TIMEOUT_FALLBACK_MINUTES` export removed — delete it and its import sites; the settings default is the fallback now.)

Run: `npm test` — expected: ALL PASS.

- [ ] **Step 4: Settings route and page**

`erp/src/app/api/admin/settings/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { allSettings, setSetting } from "@/server/settings";

export const GET = handle(async (req) => {
  mustCan(await requireUser(req), "admin", "view");
  return NextResponse.json(await allSettings());
});

export const PUT = handle(async (req) => {
  mustCan(await requireUser(req), "admin", "edit");
  const { key, value } = z.object({ key: z.string(), value: z.unknown() }).parse(await req.json());
  await setSetting(key, value);
  return NextResponse.json({ ok: true });
});
```

`erp/src/app/admin/settings/page.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";

type Row = { key: string; label: string; group: string; value: unknown };

export default function SettingsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = () => api<Row[]>("/api/admin/settings").then(setRows).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function save(row: Row, raw: string) {
    const value = typeof row.value === "number" ? Number(raw) : raw;
    try {
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ key: row.key, value }) });
      setSaved(row.key); setError(null); setTimeout(() => setSaved(null), 1500); void load();
    } catch (e) { setError((e as Error).message); }
  }

  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <div className="max-w-2xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">Settings</h1>
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {groups.map((g) => (
        <section key={g} className="mb-6">
          <h2 className="mb-2 font-medium">{g}</h2>
          <div className="rounded border bg-white">
            {rows.filter((r) => r.group === g).map((r) => (
              <label key={r.key} className="flex items-center justify-between border-b p-2 text-sm last:border-0">
                <span>{r.label}{saved === r.key && <em className="ml-2 text-green-700">saved</em>}</span>
                <input defaultValue={String(r.value)}
                       onBlur={(e) => { if (e.target.value !== String(r.value)) void save(r, e.target.value); }}
                       className="w-56 rounded border px-2 py-1" />
              </label>
            ))}
          </div>
        </section>
      ))}
      <p className="text-xs text-slate-500">Values save on blur. Invalid values are rejected with a message and nothing is stored.</p>
    </div>
  );
}
```

Manual check: set company name, blur → "saved"; set session timeout to "abc" → error shown, value unchanged.

- [ ] **Step 5: Commit**

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "feat: typed settings registry, audited writes, settings page; session timeout now setting-driven"
```

---

### Task 11: App shell — layout, permission-aware nav, home page, route protection

**Files:**
- Create: `erp/src/components/Shell.tsx`, `erp/src/app/api/auth/me/route.ts`
- Modify: `erp/src/app/layout.tsx`, `erp/src/app/page.tsx`
- Test: `erp/tests/me-route.test.ts`

**Interfaces:**
- Consumes: `requireUser`, `can` (client-side re-check uses the permission list from `/api/auth/me`).
- Produces:
  - `GET /api/auth/me` → `{ id, username, displayName, permissions: string[] }` (the **effective** permission set: role grants + GRANT overrides − DENY overrides) or 401.
  - `<Shell>` layout component: left nav with entries `[Orders, Quotes, Certifications, Shipping, Invoicing, A/R, Customers, Parts, Processes, Reports, Admin]` — each tagged with its area; entries hidden unless `"{area}.view"` is in the effective set; Admin section links to Users / Roles / Settings / Audit. Header: global search input (placeholder — wired in Phase 3, shows "Search arrives with Orders phase" toast on submit), user menu with display name + Sign out.
  - Unauthenticated visits to any page redirect to `/login` (server-side check in the layout).

- [ ] **Step 1: Failing /api/auth/me test**

`erp/tests/me-route.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { hashPassword } from "@/server/password";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as me } from "@/app/api/auth/me/route";

describe("/api/auth/me", () => {
  beforeEach(async () => await truncateAll());

  it("returns effective permissions (role + GRANT − DENY)", async () => {
    const role = await prisma.role.create({
      data: { name: "Office", permissions: { create: [{ permission: "orders.view" }, { permission: "orders.edit" }] } },
    });
    const user = await prisma.user.create({
      data: {
        username: "jane", displayName: "Jane", passwordHash: await hashPassword("secret1"), roleId: role.id,
        overrides: { create: [
          { permission: "reports.view", mode: "GRANT" },
          { permission: "orders.edit", mode: "DENY" },
        ] },
      },
    });
    const loginRes = await login(new Request("http://t/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "jane", password: "secret1" }),
    }), { params: Promise.resolve({}) });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];
    const res = await me(new Request("http://t/api/auth/me", { headers: { cookie } }), { params: Promise.resolve({}) });
    const body = await res.json();
    expect(body.id).toBe(user.id);
    expect(body.permissions.sort()).toEqual(["orders.view", "reports.view"]);
  });

  it("401s without a session", async () => {
    const res = await me(new Request("http://t/api/auth/me"), { params: Promise.resolve({}) });
    expect(res.status).toBe(401); // (one-arg handler calls are a type error now that ctx is required)
  });
});
```

Run: `npm test tests/me-route.test.ts` — expected: FAIL.

- [ ] **Step 2: Implement /api/auth/me**

`erp/src/app/api/auth/me/route.ts`:

```ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";

export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const rolePerms = user.role?.permissions.map((p) => p.permission) ?? [];
  const grants = user.overrides.filter((o) => o.mode === "GRANT").map((o) => o.permission);
  const denies = new Set(user.overrides.filter((o) => o.mode === "DENY").map((o) => o.permission));
  const effective = [...new Set([...rolePerms, ...grants])].filter((p) => !denies.has(p));
  return NextResponse.json({
    id: user.id, username: user.username, displayName: user.displayName, permissions: effective,
  });
});
```

Run: `npm test tests/me-route.test.ts` — expected: PASS.

- [ ] **Step 3: Shell component**

`erp/src/components/Shell.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";

type Me = { displayName: string; permissions: string[] };

const NAV: { label: string; href: string; area: string }[] = [
  { label: "Orders", href: "/orders", area: "orders" },
  { label: "Quotes", href: "/quotes", area: "quotes" },
  { label: "Certifications", href: "/certs", area: "certs" },
  { label: "Shipping", href: "/shipping", area: "shipping" },
  { label: "Invoicing", href: "/invoicing", area: "invoicing" },
  { label: "A/R", href: "/ar", area: "ar" },
  { label: "Customers", href: "/customers", area: "customers" },
  { label: "Parts", href: "/parts", area: "parts" },
  { label: "Processes", href: "/processes", area: "processes" },
  { label: "Reports", href: "/reports", area: "reports" },
];

const ADMIN = [
  { label: "Users", href: "/admin/users" },
  { label: "Roles", href: "/admin/roles" },
  { label: "Settings", href: "/admin/settings" },
  { label: "Audit log", href: "/admin/audit" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch(() => router.push("/login"));
  }, [router]);

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  if (pathname === "/login") return <>{children}</>;
  if (!me) return null;

  const canView = (area: string) => me.permissions.includes(`${area}.view`);

  return (
    <div className="flex min-h-screen bg-slate-100">
      <aside className="w-52 shrink-0 bg-slate-900 text-slate-100">
        <div className="p-4 text-lg font-semibold">Shop ERP</div>
        <nav className="space-y-1 px-2 text-sm">
          {NAV.filter((n) => canView(n.area)).map((n) => (
            <Link key={n.href} href={n.href}
                  className={`block rounded px-2 py-1.5 hover:bg-slate-700 ${pathname.startsWith(n.href) ? "bg-slate-700" : ""}`}>
              {n.label}
            </Link>
          ))}
          {canView("admin") && (
            <>
              <div className="pt-3 text-xs uppercase text-slate-400">Admin</div>
              {ADMIN.map((n) => (
                <Link key={n.href} href={n.href}
                      className={`block rounded px-2 py-1.5 hover:bg-slate-700 ${pathname.startsWith(n.href) ? "bg-slate-700" : ""}`}>
                  {n.label}
                </Link>
              ))}
            </>
          )}
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex items-center gap-4 border-b bg-white px-4 py-2">
          <form className="flex-1" onSubmit={(e) => { e.preventDefault(); setNotice("Search arrives with the Orders phase."); setTimeout(() => setNotice(null), 2000); }}>
            <input placeholder="Search orders, POs, parts… (scan a traveler barcode)"
                   className="w-full max-w-xl rounded border px-3 py-1.5 text-sm" />
          </form>
          {notice && <span className="text-xs text-slate-500">{notice}</span>}
          <span className="text-sm">{me.displayName}</span>
          <button onClick={signOut} className="rounded border px-2 py-1 text-sm">Sign out</button>
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire layout and home page**

`erp/src/app/layout.tsx` — replace body contents:

```tsx
import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "@/components/Shell";

export const metadata: Metadata = { title: "Shop ERP" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
```

`erp/src/app/page.tsx`:

```tsx
export default function Home() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Welcome</h1>
      <p className="mt-2 text-sm text-slate-600">
        Foundation phase. The order board lands here in Phase 3.
      </p>
    </div>
  );
}
```

Manual check: signed out → any page bounces to `/login`; signed in as admin → nav shows Admin links; a user with only `orders.view` sees only Orders (create one to verify); search box shows the placeholder notice.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected: ALL PASS.

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "feat: app shell with permission-aware nav, /api/auth/me, login redirect"
```

---

### Task 12: Production packaging — Dockerfile, compose app + nightly backup

**Files:**
- Create: `erp/Dockerfile`, `erp/scripts/backup.sh`, `erp/README.md`
- Modify: `erp/docker-compose.yml`, `erp/next.config.ts`

**Interfaces:**
- Produces: `docker compose up -d` on any Docker host brings up db + app (port 80→3000) + nightly `pg_dump` into `./backups/` keeping 30 days. `README.md` documents: first run, seeding, backup restore, updating.

- [ ] **Step 1: Standalone Next build**

`erp/next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```

- [ ] **Step 2: Dockerfile**

`erp/Dockerfile`:

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
```

- [ ] **Step 3: Backup script and compose services**

`erp/scripts/backup.sh`:

```bash
#!/bin/sh
# Nightly pg_dump; keeps 30 days of compressed backups.
set -e
STAMP=$(date +%Y-%m-%d_%H%M)
pg_dump "$DATABASE_URL" | gzip > "/backups/erp_${STAMP}.sql.gz"
find /backups -name 'erp_*.sql.gz' -mtime +30 -delete
echo "backup complete: erp_${STAMP}.sql.gz"
```

Replace `erp/docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: erp
      POSTGRES_PASSWORD: erp_local_dev
      POSTGRES_DB: erp
    ports: ["5432:5432"]
    volumes:
      - dbdata:/var/lib/postgresql/data
      - ./db-init:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U erp"]
      interval: 5s
      timeout: 3s
      retries: 20

  app:
    build: .
    ports: ["80:3000"]
    environment:
      DATABASE_URL: postgresql://erp:erp_local_dev@db:5432/erp
      SESSION_SECRET: ${SESSION_SECRET:?set in .env}
    depends_on:
      db: { condition: service_healthy }
    profiles: ["prod"]

  backup:
    image: postgres:16
    environment:
      DATABASE_URL: postgresql://erp:erp_local_dev@db:5432/erp
    volumes:
      - ./backups:/backups
      - ./scripts/backup.sh:/backup.sh:ro
    entrypoint: ["sh", "-c", "while true; do sh /backup.sh; sleep 86400; done"]
    depends_on:
      db: { condition: service_healthy }
    profiles: ["prod"]

volumes:
  dbdata:
```

(Dev keeps using `docker compose up -d db` + `npm run dev`; production is `docker compose --profile prod up -d --build`.)

- [ ] **Step 4: README**

`erp/README.md`:

```markdown
# Shop ERP

Self-hosted web ERP for the heat-treat shop. Next.js + Prisma + PostgreSQL.

## Development
1. `docker compose up -d db`
2. `npm install && npx prisma migrate dev`
3. Apply migrations to the test DB:
   `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`
4. `npm run db:seed` (creates admin/admin — change the password after first login)
5. `npm run dev` → http://localhost:3000
6. `npm test`

## Production (single box on the shop network)
1. Copy `.env.example` → `.env`; set a strong `SESSION_SECRET` and change the db password
   in `docker-compose.yml` + `DATABASE_URL`s together.
2. `docker compose --profile prod up -d --build`
3. First run only: `docker compose exec app npx tsx prisma/seed.ts`
4. App at http://<server>/ — migrations apply automatically on start.

## Backups
- Nightly `pg_dump` gzip into `./backups/`, 30 days kept (backup container).
- Restore: `gunzip -c backups/erp_<stamp>.sql.gz | docker compose exec -T db psql -U erp -d erp`

## Updating
`git pull && docker compose --profile prod up -d --build` — users just refresh.
```

- [ ] **Step 5: Verify and commit**

Run: `docker compose --profile prod up -d --build`, open `http://localhost/api/health` — expected `{"ok":true,"db":true}`; `docker compose exec backup sh /backup.sh` — expected a `backups/erp_*.sql.gz` file. Then `docker compose --profile prod down`.

```bash
cd "/home/cojoa13/Desktop/Claude new" && git add -A && git commit -m "chore: production Dockerfile, compose app+backup services, README"
```

---

## Phase 1 completion checklist

- [ ] `npm test` — entire suite green.
- [ ] Fresh clone → README dev steps → login as seeded admin works.
- [ ] Roles page: create role, tick permissions, they persist and gate both nav and API (verify with a limited user).
- [ ] Users page: create, deactivate (blocks login), reset password; no delete anywhere.
- [ ] Every user/role/setting change appears in `/admin/audit` with actor and before/after.
- [ ] Settings page validates (bad timeout rejected) and drives session expiry.
- [ ] `docker compose --profile prod up -d --build` serves the app on port 80 with auto-migrations; nightly backup file appears.
- [ ] Owner demo: log in, create a "Front Office" role and a user for a real employee, change company name in settings, watch the audit trail.
