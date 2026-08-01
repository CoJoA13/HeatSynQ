# Phase 2C-1 — Shared Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the five cross-cutting mechanisms Phase 2C inherits — FK name resolution, the reference-delete guard, the pick-list read route, the permission-gating helper, and `deleteRole`'s reason — each as one shared implementation, around a single foreign-key registry.

**Architecture:** Two of the five obligations need the same fact in opposite directions: name resolution asks "given `customer.termsId`, what is the Terms name?", the delete guard asks "given a Terms row, who points at me?". A hand-written registry in `src/lib/reference-links.ts` holds that fact once, and a schema-walking sweep test fails the build if a new foreign key isn't registered. Everything else consumes it.

**Tech Stack:** Next.js 15.5 · React 19 · Prisma 7.9.1 + `@prisma/adapter-pg` · PostgreSQL 16 · Vitest 3.2 · zod 4 · exceljs · TypeScript 5.9.3

**Spec:** `docs/superpowers/specs/2026-08-01-phase-2c1-shared-foundations-design.md` — read it before Task 1.

## Global Constraints

- **Branch:** `phase-2c1-foundations`, already cut from `main` at `ed355a9`. The spec commit `430bc5f` is its first commit.
- **All four gates green at every commit:** `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`. All commands run from `erp/`. Baseline is **258 passing / 0 skipped**.
- **NO SCHEMA CHANGE IN THIS BRANCH.** Nothing here adds or alters a Prisma model, so no migration is created and `prisma migrate dev`'s TTY restriction never arises. If a task seems to need a schema change, stop and report — it means the plan is wrong.
- **Client components must not import from `src/server/**`** — it drags `node:async_hooks` and Prisma into the browser bundle. Shared constants go in `src/lib/` (`permission-constants.ts` and `reference-constants.ts` are the precedents).
- **Every mutation goes through the audit helpers** (`auditedCreate`/`auditedUpdate`/`auditedSoftDelete`). Deletion is always soft.
- **Route handlers stay thin:** `requireUser()` + `mustCan`/`mustDo` first, zod parse, delegate to a service. Business rules live in `src/server/*.ts`.
- **Route handler tests must pass ctx:** `handler(request, { params: Promise.resolve({ kind: "terms" }) })`.
- **Unique columns on soft-deletable models are unique only among live rows.** Never `findUnique`/`upsert`/`update`/`delete` keyed on such a column — `tests/partial-unique-sweep.test.ts` fails the build. Use `findFirst({ where: { name, deletedAt: null } })`.
- **Conventional commits** ending with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Errors:** `HttpError(400/403/404, message)` for expected failures, field-anchored messages. `handle()` converts `HttpError` and `ZodError`; anything else escaping is a bug.

---

## File Structure

**Created**
- `erp/src/lib/reference-links.ts` — the FK registry and its lookup helpers. Pure constants, client-safe.
- `erp/src/lib/permission-ui.ts` — `gate` / `gateDo`. Pure functions over the permission-key array, client-safe.
- `erp/src/server/reference-blockers.ts` — computes the blocker list for a reference row. Server-only; imports Prisma.
- `erp/src/app/api/picklists/[kind]/route.ts` — the session-only pick-list read route.
- `erp/src/app/api/admin/reference/[kind]/[id]/blockers/export/route.ts` — Excel export of one row's blocker list.
- `erp/tests/reference-links-sweep.test.ts` — fails on an unregistered FK.
- `erp/tests/picklists.test.ts`, `erp/tests/reference-names.test.ts`, `erp/tests/reference-blockers.test.ts`, `erp/tests/permission-ui.test.ts`.

**Modified**
- `erp/src/lib/reference-constants.ts` — add `PICKLIST_KINDS` / `PickListKind`.
- `erp/src/server/reference.ts` — resolve names on read; accept names on write; block deletes with blockers.
- `erp/src/server/roles.ts` — `deleteRole(roleId, reason)`.
- `erp/src/components/ReferenceTable.tsx` — render resolved names, ref columns become selects, blocker panel, permission gating.
- `erp/src/app/customers/[id]/page.tsx` — pick-list route, drop the soft catch, permission gating.
- `erp/src/app/admin/roles/page.tsx` — collect the delete reason.
- `erp/src/app/api/admin/reference/[kind]/export/route.ts` — export resolved names.

Why `reference-blockers.ts` is its own file rather than more of `reference.ts`: `reference.ts` is already the generic CRUD service for ten kinds, and blocker computation is a different responsibility with a different shape (it reads *other* models). Splitting keeps both small enough to hold in context.

---

## Task 1: The FK registry and its sweep

**Files:**
- Create: `erp/src/lib/reference-links.ts`
- Create: `erp/tests/reference-links-sweep.test.ts`

**Interfaces:**
- Consumes: `ReferenceKind` from `src/lib/reference-constants.ts`.
- Produces: `REFERENCE_LINKS: ReferenceLink[]`, `linksTargeting(kind): ReferenceLink[]`, `linksFrom(model): ReferenceLink[]`, types `ReferenceLink` and `ReferenceLinkModel`. Every later task consumes these.

- [ ] **Step 1: Write the registry**

Create `erp/src/lib/reference-links.ts`:

```ts
// Pure constants — safe to import from client components (no server imports).
import type { ReferenceKind } from "./reference-constants";

/** Models that hold a foreign key pointing at a reference table. */
export type ReferenceLinkModel = "customer" | "processStepCode" | "paymentType" | "inspectionCode";

export type ReferenceLink = {
  /** Prisma model holding the foreign key. */
  model: ReferenceLinkModel;
  /** The FK column on that model. */
  column: string;
  /** The reference kind it points at. `ReferenceKind`, NOT `PickListKind` — a link may target
   *  `glAccount`, which is deliberately not served by the pick-list route. */
  targetKind: ReferenceKind;
  /** Column header wherever this FK is displayed or exported. */
  label: string;
  /** How a blocker row names its own kind in the blocked-delete list. */
  entityLabel: string;
  /** Detail-page path. Omitted where the entity has no detail page — the admin grids are small
   *  and unpaginated, so the row is already on screen (owner ruling, spec §7.1). */
  detailPath?: (id: string) => string;
};

/** The single source of truth for "which column points at which reference kind".
 *  Two consumers read it in opposite directions: name resolution forward (given a column,
 *  show the target's name), the delete guard inverted (given a kind, who points at me).
 *  tests/reference-links-sweep.test.ts fails the build if a schema FK is missing here. */
export const REFERENCE_LINKS: ReferenceLink[] = [
  { model: "customer", column: "termsId", targetKind: "terms",
    label: "Terms", entityLabel: "Customer", detailPath: (id) => `/customers/${id}` },
  { model: "processStepCode", column: "glAccountId", targetKind: "glAccount",
    label: "GL account", entityLabel: "Process step code" },
  { model: "paymentType", column: "glAccountId", targetKind: "glAccount",
    label: "GL account", entityLabel: "Payment type" },
  { model: "inspectionCode", column: "defaultScaleId", targetKind: "inspectionScale",
    label: "Default scale", entityLabel: "Inspection code" },
];

/** Everything pointing AT this kind — the delete guard's direction. */
export function linksTargeting(kind: ReferenceKind): ReferenceLink[] {
  return REFERENCE_LINKS.filter((l) => l.targetKind === kind);
}

/** Everything this model points at — name resolution's direction. */
export function linksFrom(model: string): ReferenceLink[] {
  return REFERENCE_LINKS.filter((l) => l.model === model);
}

/** `defaultScaleId` → `defaultScaleName`. The resolved-name key returned alongside the id. */
export function nameKey(column: string): string {
  return `${column.replace(/Id$/, "")}Name`;
}
```

- [ ] **Step 2: Write the sweep test**

Create `erp/tests/reference-links-sweep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REFERENCE_LINKS } from "@/lib/reference-links";
import { REFERENCE_KINDS } from "@/lib/reference-constants";

const SCHEMA = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

/** Every `model X { … }` block, as [name, body]. */
function models(): [string, string][] {
  return [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => [m[1], m[2]]);
}

/** `GlAccount` → `glAccount`. Prisma model names are PascalCase; reference kinds are the
 *  same word camelCased, which is what makes this mapping safe rather than a guess. */
function toKind(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

describe("reference links sweep", () => {
  // The registry is what gives a foreign key its delete protection and its name resolution.
  // A new FK that nobody registers gets neither — silently. Phase 2C-2 adds four of them to
  // Part, which is exactly when this needs to bite.
  it("every schema foreign key pointing at a reference table is registered", () => {
    const kinds = new Set<string>(REFERENCE_KINDS);
    const registered = new Set(REFERENCE_LINKS.map((l) => `${l.model}.${l.column}`));
    const offenders: string[] = [];

    for (const [modelName, body] of models()) {
      // A Prisma relation field looks like:
      //   glAccount  GlAccount? @relation(fields: [glAccountId], references: [id])
      // …or, when the relation is named:
      //   parent  Customer? @relation("CustomerHierarchy", fields: [parentId], references: [id])
      // The optional name group is NOT cosmetic: Prisma *requires* a relation name whenever two
      // FKs from one model point at the same model, so a regex demanding `@relation(fields:`
      // goes blind exactly when a model gains a second reference to the same reference table —
      // and that FK then silently gets no delete protection and no name resolution.
      for (const m of body.matchAll(/^\s*\w+\s+(\w+)\??\s+@relation\((?:"[^"]*"\s*,\s*)?fields:\s*\[(\w+)\]/gm)) {
        const [, targetModel, column] = m;
        if (!kinds.has(toKind(targetModel))) continue;   // not a reference table
        const key = `${toKind(modelName)}.${column}`;
        if (!registered.has(key)) offenders.push(`${key} -> ${toKind(targetModel)}`);
      }
    }

    expect(offenders, `These foreign keys point at a reference table but are missing from
REFERENCE_LINKS in src/lib/reference-links.ts. Unregistered means no delete protection and no
name resolution — both fail silently. Add an entry per offender.`).toEqual([]);
  });

  // Guards the sweep against passing vacuously. Note what each assertion actually covers:
  // the length checks exercise only the model-block regex and the registry, so the third
  // assertion is the one that exercises the RELATION regex — with an empty registry, every
  // known FK must be reported. Without it, a broken relation match would leave offenders
  // trivially empty and the main sweep would pass while checking nothing.
  it("the sweep actually parses the schema, relations included", () => {
    expect(models().length).toBeGreaterThan(15);
    expect(REFERENCE_LINKS.length).toBeGreaterThanOrEqual(4);
    expect(unregisteredLinks(SCHEMA, new Set()).sort()).toEqual([
      "customer.termsId -> terms",
      "inspectionCode.defaultScaleId -> inspectionScale",
      "paymentType.glAccountId -> glAccount",
      "processStepCode.glAccountId -> glAccount",
    ]);
  });

  it("every registered link targets a real reference kind", () => {
    const kinds = new Set<string>(REFERENCE_KINDS);
    expect(REFERENCE_LINKS.filter((l) => !kinds.has(l.targetKind)).map((l) => l.targetKind)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it**

```bash
npx vitest run tests/reference-links-sweep.test.ts
```
Expected: 3 passing. If the first test reports offenders, the registry is missing a real FK — add it rather than weakening the regex.

- [ ] **Step 4: Prove the sweep bites**

Temporarily add an unregistered FK to `erp/prisma/schema.prisma` — on `Customer`, add:

```prisma
  carrierId String?
  carrier   Carrier? @relation(fields: [carrierId], references: [id])
```
and on `Carrier`, add `customers Customer[]`.

```bash
npx vitest run tests/reference-links-sweep.test.ts
```
Expected: **FAIL**, naming `customer.carrierId -> carrier`.

**Revert both edits** (`git checkout -- prisma/schema.prisma`), re-run to confirm green, and confirm `git diff --exit-code` is clean. A sweep never seen to fail is decoration, not a guard.

- [ ] **Step 5: Run all four gates**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: **261 passing / 0 skipped** (258 + 3).

- [ ] **Step 6: Commit**

```bash
git add src/lib/reference-links.ts tests/reference-links-sweep.test.ts
git commit -m "$(cat <<'EOF'
feat: add the reference foreign-key registry and its sweep

Two of Phase 2C-1's obligations need the same fact in opposite directions:
name resolution asks "given customer.termsId, what is the Terms name", the
delete guard asks "given a Terms row, who points at me". One registry holds
it; a schema-walking sweep fails the build when a new FK is unregistered,
which is what stops 2C-2's part columns from silently getting neither.

detailPath is optional because only customers have a detail page today —
the admin grids are small and unpaginated (owner ruling, spec §7.1).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: The pick-list read route

Built before name resolution because the reference grid's FK inputs become selects fed by this route in Task 4.

**Files:**
- Modify: `erp/src/lib/reference-constants.ts` (append)
- Create: `erp/src/app/api/picklists/[kind]/route.ts`
- Create: `erp/tests/picklists.test.ts`

**Interfaces:**
- Produces: `PICKLIST_KINDS`, `PickListKind`; `GET /api/picklists/[kind]` returning `{ id, name, active }[]`.

- [ ] **Step 1: Add the kind set**

Append to `erp/src/lib/reference-constants.ts`:

```ts
/** Kinds readable by any signed-in user. A distinct set from ReferenceKind, and NOT a subset:
 *  it drops glAccount (the one kind no data-entry screen reads — keeping chart-of-accounts
 *  numbers off a route everyone can reach) and adds processStepCode, which is not a reference
 *  kind at all but which the Phase 2C-3 Process Steps designer must read. */
export const PICKLIST_KINDS = [
  ...REFERENCE_KINDS.filter((k) => k !== "glAccount"),
  "processStepCode",
] as const;
export type PickListKind = (typeof PICKLIST_KINDS)[number];
```

- [ ] **Step 2: Write the failing tests**

Create `erp/tests/picklists.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { createReference } from "@/server/reference";
import { createStepCode } from "@/server/process-step-codes";
import { GET } from "@/app/api/picklists/[kind]/route";
import { signInWith } from "./helpers/auth";

const ctx = (kind: string) => ({ params: Promise.resolve({ kind }) });

describe("pick-list route", () => {
  beforeEach(async () => await truncateAll());

  it("401s without a session", async () => {
    const res = await GET(new Request("http://x/api/picklists/material"), ctx("material"));
    expect(res.status).toBe(401);
  });

  it("serves a kind to a user holding NO area permissions", async () => {
    // The whole point: a user with customers.edit but not admin.view must still see Terms.
    // Nothing to grant means nothing to forget.
    await createReference("material", { name: "4140" });
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/material", { headers: { cookie } }),
                          ctx("material"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: expect.any(String), name: "4140", active: true }]);
  });

  it("serves process step codes without leaking their GL account", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    await createStepCode({ code: "HT-01", name: "Austenitize", glAccountId: gl.id });
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/processStepCode", { headers: { cookie } }),
                          ctx("processStepCode"));
    const [row] = await res.json();
    expect(row).toEqual({ id: expect.any(String), name: expect.stringContaining("HT-01"), active: true });
    expect(row).not.toHaveProperty("glAccountId");
  });

  it("404s glAccount — it stays admin-only", async () => {
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/glAccount", { headers: { cookie } }),
                          ctx("glAccount"));
    expect(res.status).toBe(404);
  });

  it("404s an unknown kind", async () => {
    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/nope", { headers: { cookie } }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("excludes soft-deleted rows and, by default, inactive ones", async () => {
    const live = await createReference("carrier", { name: "UPS" });
    const dead = await createReference("carrier", { name: "Gone" });
    await deleteReference("carrier", dead.id);
    const off = await createReference("carrier", { name: "Retired" });
    await updateReference("carrier", off.id, { active: false });

    const cookie = await signInWith([]);
    const res = await GET(new Request("http://x/api/picklists/carrier", { headers: { cookie } }), ctx("carrier"));
    expect((await res.json()).map((r: { id: string }) => r.id)).toEqual([live.id]);

    // includeInactive=1 brings back the inactive row but never the deleted one — an assigned
    // inactive value must still render, which is the inactive-vs-deleted distinction.
    const res2 = await GET(new Request("http://x/api/picklists/carrier?includeInactive=1", { headers: { cookie } }),
                           ctx("carrier"));
    const ids = (await res2.json()).map((r: { id: string }) => r.id);
    expect(ids).toContain(off.id);
    expect(ids).not.toContain(dead.id);
  });
});
```

Add `deleteReference, updateReference` to the `@/server/reference` import.

**`signInWith([])` must produce a user with an empty permission set.** Check `tests/helpers/auth.ts` for its current signature; if it does not already accept a permission list, extend it in this task so it can, and say so in the report.

- [ ] **Step 3: Run to watch them fail**

```bash
npx vitest run tests/picklists.test.ts
```
Expected: FAIL — the route module does not exist.

- [ ] **Step 4: Implement the service, then the route**

**Corrected 2026-08-01 (Task 2 review).** This step originally put the Prisma queries and the
`processStepCode` branch directly in the route handler, which violates `CLAUDE.md`'s binding
architecture: *"Handlers stay thin and follow a fixed shape — authorize, parse, delegate.
Business rules live in the services under `src/server/*.ts`."* Every comparable route obeys it.
Put the logic in `erp/src/server/picklists.ts` as
`listPickList(kind, opts?): Promise<{id;name;active}[]>` — owning kind validation (404 for an
unknown or excluded kind), the deletedAt/active filter, the processStepCode branch and its
narrow projection, and a loud failure if the delegate does not resolve — and reduce the route to
authorize, parse, delegate.

The route body below shows the *pre-correction* shape; keep its comments and gate, but move the
query logic into the service:

```ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { HttpError } from "@/server/errors";
import { prisma } from "@/server/db";
import { PICKLIST_KINDS, type PickListKind } from "@/lib/reference-constants";

/** Read-only, gated on a session alone. Reference names are vocabulary, not secrets — materials
 *  and specifications are the language of the paperwork customers already receive. Create/edit/
 *  delete stay under `admin` on /api/admin/reference/*. A 13th permission area was considered
 *  and rejected: it would relocate the silent-empty-dropdown failure to a role misconfiguration
 *  instead of removing it. */
export const GET = handle(async (req, ctx: { params: Promise<{ kind: string }> }) => {
  requireUser();
  const { kind } = await ctx.params;
  if (!(PICKLIST_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(404, `Unknown pick list: ${kind}`);
  }
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "1";
  const where = { deletedAt: null, ...(includeInactive ? {} : { active: true }) };

  if (kind === "processStepCode") {
    const rows = await prisma.processStepCode.findMany({
      where, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, active: true },
    });
    // Narrow projection on purpose: the GL account these carry never crosses this route.
    return NextResponse.json(rows.map((r) => ({ id: r.id, name: `${r.code} — ${r.name}`, active: r.active })));
  }

  const delegate = prisma[kind as Exclude<PickListKind, "processStepCode">] as unknown as {
    findMany: (a: object) => Promise<{ id: string; name: string; active: boolean }[]>;
  };
  return NextResponse.json(await delegate.findMany({
    where, orderBy: { name: "asc" }, select: { id: true, name: true, active: true },
  }));
});
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run tests/picklists.test.ts
```
Expected: all pass.

- [ ] **Step 6: Point the customer page's Terms dropdown at the new route**

This is the bug the route exists for, so the branch must not leave it unfixed. In `erp/src/app/customers/[id]/page.tsx` line ~105:

```ts
// BEFORE — behind admin.view, and a failure is indistinguishable from "no terms configured"
api<Term[]>("/api/admin/reference/terms?includeInactive=1").then(setTerms).catch(() => {});

// AFTER — session-only, and a failure says so
api<Term[]>("/api/picklists/terms?includeInactive=1").then(setTerms)
  .catch((e) => setError(`Could not load terms: ${(e as Error).message}`));
```

`includeInactive=1` is kept deliberately: a customer already assigned an inactive Terms row must still render its name rather than a blank select (handoff §4a, round 4's fix).

The page already has a `setError` banner — reuse it rather than adding a second error channel. Leave the other `.catch(() => {})` calls in that file alone: they guard *reload-after-save* paths, not pick-list fetches, and handoff §5.13 warns that a reload which clears the error banner must never run after the error is set.

- [ ] **Step 7: Run all four gates and commit**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add src/lib/reference-constants.ts src/app/api/picklists src/app/customers/[id]/page.tsx tests/picklists.test.ts tests/helpers/auth.ts
git commit -m "$(cat <<'EOF'
feat: add a session-only pick-list read route

A user holding customers.edit but not admin.view currently gets an empty Terms
dropdown, because reference data lives entirely behind admin.view — and the
fetch ends in .catch(() => {}), so it looks exactly like a shop with no terms
configured. One read-only route fixes it for every kind at once.

glAccount is excluded and stays admin.view-only; processStepCode is included
because the 2C-3 designer reads it, with a projection that omits its GL
account so serving it leaks nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Resolve FK names on read and export

**Files:**
- Modify: `erp/src/server/reference.ts` (`listReference`)
- Modify: `erp/src/app/api/admin/reference/[kind]/export/route.ts`
- Create: `erp/tests/reference-names.test.ts`

**Interfaces:**
- Consumes: `linksFrom`, `nameKey` from Task 1.
- Produces: `listReference` rows carry `<column>Name` alongside `<column>` (e.g. `defaultScaleName` next to `defaultScaleId`). Task 4 and the UI depend on that key.

- [ ] **Step 1: Write the failing test**

Create `erp/tests/reference-names.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { listReference, createReference, updateReference, deleteReference } from "@/server/reference";

describe("reference FK name resolution", () => {
  beforeEach(async () => await truncateAll());

  it("lists the target's name beside the id, not a bare cuid", async () => {
    const scale = await createReference("inspectionScale", { name: "Rockwell C" });
    await createReference("inspectionCode", { name: "HRC-1", defaultScaleId: scale.id });

    const [row] = await listReference("inspectionCode");
    expect(row.defaultScaleId).toBe(scale.id);
    expect(row.defaultScaleName).toBe("Rockwell C");
  });

  it("resolves an INACTIVE target — inactive hides from pick lists, it does not invalidate data", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    await createReference("paymentType", { name: "Check", glAccountId: gl.id });
    await updateReference("glAccount", gl.id, { active: false });

    const [row] = await listReference("paymentType");
    expect(row.glAccountName).toBe("4010");
  });

  it("leaves the name null when the column is null", async () => {
    await createReference("paymentType", { name: "Cash" });
    const [row] = await listReference("paymentType");
    expect(row.glAccountId).toBeNull();
    expect(row.glAccountName).toBeNull();
  });

  it("leaves the name null when the target was soft-deleted out from under it", async () => {
    // assertTermsExists-style guards stop this arising going forward, but rows predating the
    // guard exist; the list must degrade to a null name rather than throwing.
    const scale = await createReference("inspectionScale", { name: "Brinell" });
    await createReference("inspectionCode", { name: "HB-1", defaultScaleId: scale.id });
    await deleteReference("inspectionScale", scale.id);

    const [row] = await listReference("inspectionCode");
    expect(row.defaultScaleName).toBeNull();
  });
});
```

- [ ] **Step 2: Run to watch it fail**

```bash
npx vitest run tests/reference-names.test.ts
```
Expected: FAIL — `defaultScaleName` is `undefined`.

- [ ] **Step 3: Resolve names in `listReference`**

In `erp/src/server/reference.ts`, add the import and replace `listReference`:

```ts
import { linksFrom, nameKey } from "../lib/reference-links";
```

```ts
export async function listReference(
  kind: string, opts?: { includeInactive?: boolean },
): Promise<ReferenceRow[]> {
  assertKind(kind);
  const rows = await delegate(kind).findMany({
    where: { deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: { name: "asc" },
  });

  // Resolve each FK column to the target's name, so screens and Excel show "Rockwell C"
  // rather than a cuid. One batched query per link, not one per row.
  for (const link of linksFrom(kind)) {
    const ids = [...new Set(rows.map((r) => r[link.column]).filter((v): v is string => typeof v === "string"))];
    // Deleted targets resolve to null rather than throwing — rows predating the FK guards exist.
    const targets = ids.length
      ? await delegate(link.targetKind).findMany({ where: { id: { in: ids }, deletedAt: null } })
      : [];
    const byId = new Map(targets.map((t) => [t.id, t.name]));
    for (const row of rows) {
      const id = row[link.column];
      row[nameKey(link.column)] = typeof id === "string" ? byId.get(id) ?? null : null;
    }
  }
  return rows;
}
```

`RefDelegate.findMany` already returns `ReferenceRow` (`{ id; name; active } & Record<string, unknown>`), so the target lookup needs no new delegate member. `delegate()` takes a `ReferenceKind`; `link.targetKind` is one by construction.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/reference-names.test.ts
```
Expected: all pass.

- [ ] **Step 5: Export the name instead of the id**

In `erp/src/app/api/admin/reference/[kind]/export/route.ts`, the columns are built from `REFERENCE_EXTRA_FIELDS[kind]`. For entries with `kind: "ref"`, emit the resolved-name key:

```ts
import { nameKey } from "@/lib/reference-links";
```
```ts
  const columns = [
    { key: "name", header: labels.nameLabel },
    ...REFERENCE_EXTRA_FIELDS[kind].map((f) => ({
      // A ref column exports the resolved name — a cuid in a spreadsheet is unusable, and
      // paste (Task 4) reads this same column back by name.
      key: f.kind === "ref" ? nameKey(f.key) : f.key,
      header: f.label,
    })),
    { key: "active", header: "Active" },
  ];
```

Read the file first and adapt to its existing shape rather than pasting blindly — preserve the `Active` column and the content-disposition headers exactly.

- [ ] **Step 6: Add an export assertion**

Append to `erp/tests/reference-names.test.ts`:

```ts
  it("exports the resolved name, not the cuid", async () => {
    const scale = await createReference("inspectionScale", { name: "Rockwell C" });
    await createReference("inspectionCode", { name: "HRC-1", defaultScaleId: scale.id });

    const cookie = await signInWith(["admin.view"]);
    const res = await exportRoute(
      new Request("http://x/api/admin/reference/inspectionCode/export", { headers: { cookie } }),
      { params: Promise.resolve({ kind: "inspectionCode" }) });
    const buf = Buffer.from(await res.arrayBuffer());

    // xlsx is a zip; the shared-strings part carries cell text. Asserting on the bytes keeps
    // this a real round-trip rather than a re-assertion of what the route already returned.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const values = wb.getWorksheet(1)!.getRow(2).values as unknown[];
    expect(values).toContain("Rockwell C");
    expect(values.join(" ")).not.toContain(scale.id);
  });
```

Imports needed at the top of the file: `ExcelJS from "exceljs"`, `signInWith` from `./helpers/auth`, and `GET as exportRoute` from `@/app/api/admin/reference/[kind]/export/route`.

- [ ] **Step 7: Run all four gates and commit**

```bash
npx vitest run tests/reference-names.test.ts && npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add src/server/reference.ts src/app/api/admin/reference/[kind]/export/route.ts tests/reference-names.test.ts
git commit -m "$(cat <<'EOF'
feat: resolve reference foreign keys to names on read and export

inspectionCode.defaultScaleId and paymentType.glAccountId rendered and
exported a raw cuid — carried from Phase 2A by owner decision on the grounds
that 2C would need the general mechanism anyway. This is that mechanism,
driven by the registry, so 2C-2's part columns get it for free.

A deleted target degrades to a null name rather than throwing; an inactive one
still resolves, because inactive hides a row from pick lists without
invalidating assignments that already reference it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Accept names on create, update and paste

**Files:**
- Modify: `erp/src/server/reference.ts` (`createReference`, `updateReference`, `EXTRA_SCHEMAS`)
- Modify: `erp/src/server/paste.ts`
- Modify: `erp/src/components/ReferenceTable.tsx` (ref inputs become selects)
- Modify: `erp/tests/reference-names.test.ts`

**Interfaces:**
- Consumes: `linksFrom`, `nameKey` (Task 1); `/api/picklists/[kind]` (Task 2).
- Produces: reference create/update accept `<column>` **or** the resolved-name key. Paste columns use the name key.

- [ ] **Step 1: Write the failing tests**

Append to `erp/tests/reference-names.test.ts`:

```ts
  it("creates by name instead of cuid", async () => {
    await createReference("inspectionScale", { name: "Rockwell C" });
    const { id } = await createReference("inspectionCode", { name: "HRC-1", defaultScaleName: "Rockwell C" });
    const row = (await listReference("inspectionCode")).find((r) => r.id === id)!;
    expect(row.defaultScaleName).toBe("Rockwell C");
  });

  it("rejects an unknown name with a field-anchored message naming the value", async () => {
    await expect(createReference("inspectionCode", { name: "HRC-1", defaultScaleName: "Nope" }))
      .rejects.toThrow(/Default scale.*Nope/i);
  });

  it("rejects a name that matches only a soft-deleted row", async () => {
    const scale = await createReference("inspectionScale", { name: "Gone" });
    await deleteReference("inspectionScale", scale.id);
    await expect(createReference("inspectionCode", { name: "HRC-2", defaultScaleName: "Gone" }))
      .rejects.toThrow(/Default scale/i);
  });

  it("updates by name", async () => {
    const a = await createReference("inspectionScale", { name: "Rockwell C" });
    await createReference("inspectionScale", { name: "Brinell" });
    const code = await createReference("inspectionCode", { name: "HRC-1", defaultScaleId: a.id });
    await updateReference("inspectionCode", code.id, { defaultScaleName: "Brinell" });
    const row = (await listReference("inspectionCode")).find((r) => r.id === code.id)!;
    expect(row.defaultScaleName).toBe("Brinell");
  });

  it("pastes by name, reporting unknown names per row without discarding good rows", async () => {
    await createReference("inspectionScale", { name: "Rockwell C" });
    const result = await pasteReference("inspectionCode", "HRC-1\tRockwell C\nHRC-2\tNope\nHRC-3\tRockwell C");
    expect(result.created).toBe(2);
    expect(result.errors).toEqual([{ row: 2, message: expect.stringMatching(/Default scale.*Nope/i) }]);
  });
```

Add `pasteReference` from `@/server/paste` to the imports.

- [ ] **Step 2: Run to watch them fail**

```bash
npx vitest run tests/reference-names.test.ts -t "by name"
```
Expected: FAIL — `.strict()` rejects the unknown key `defaultScaleName`.

- [ ] **Step 3: Accept and resolve the name key**

In `erp/src/server/reference.ts`, extend `EXTRA_SCHEMAS` so ref-bearing kinds accept the name key too, then resolve before the row is written. Add above `createReference`:

```ts
/** Turns `<column>Name` input into `<column>` (an id) by looking the name up among LIVE rows of
 *  the target kind.
 *
 *  The raw id form stays accepted too. Not for the UI — the grid's select submits the name
 *  (Task 4 Step 6) — but because existing callers and tests already pass `defaultScaleId` /
 *  `glAccountId` directly, and an id is unambiguous where a name needs resolving. Removing it
 *  would be a breaking API change this task has no reason to make.
 *
 *  Returns a shallow copy — the caller's object is not mutated. */
async function resolveLinkNames(kind: ReferenceKind, input: Record<string, unknown>) {
  const data = { ...input };
  for (const link of linksFrom(kind)) {
    const key = nameKey(link.column);
    if (!(key in data)) continue;
    const raw = data[key];
    delete data[key];
    if (raw === null || raw === "") { data[link.column] = null; continue; }
    const name = String(raw).trim();
    // findFirst, not findUnique: `name` is unique only among live rows, so findUnique would
    // compile and return a soft-deleted row (tests/partial-unique-sweep.test.ts bans it).
    const target = await delegate(link.targetKind).findFirst({
      where: { name, deletedAt: null }, select: { id: true },
    });
    if (!target) throw new HttpError(400, `${link.label} "${name}" does not exist`);
    data[link.column] = target.id;
  }
  return data;
}
```

Add `defaultScaleName` / `glAccountName` as `z.string().nullable().optional()` to the matching `EXTRA_SCHEMAS` entries, and call `resolveLinkNames` at the top of both `createReference` and `updateReference`, before the zod parse:

```ts
  const data = BASE.merge(EXTRA_SCHEMAS[kind]).strict()
    .parse(await resolveLinkNames(kind, input)) as z.infer<typeof BASE> & Record<string, unknown>;
```

`RefDelegate` needs `findFirst` to accept a `select` — it already does (`{ where: object; select?: object }`).

- [ ] **Step 4: Paste by the name column**

In `erp/src/server/paste.ts`, add the import and change the column list so ref columns use the name key:

```ts
import { nameKey } from "../lib/reference-links";
```
```ts
  const columns = ["name", ...REFERENCE_EXTRA_FIELDS[kind].map((f) => (f.kind === "ref" ? nameKey(f.key) : f.key))];
```

Nothing else in `paste.ts` changes — per-row error collection already reports whatever `createReference` throws, so the "unknown name" message surfaces on the offending row for free.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run tests/reference-names.test.ts
```
Expected: all pass.

- [ ] **Step 6: Make the grid's ref inputs selects**

In `erp/src/components/ReferenceTable.tsx`. Add the imports:

```ts
import { linksFrom, nameKey } from "@/lib/reference-links";
```

Load the options for every ref column this kind has, once per kind:

```ts
  const refLinks = linksFrom(kind);
  const [refOptions, setRefOptions] = useState<Record<string, { id: string; name: string }[]>>({});

  useEffect(() => {
    if (!refLinks.length) return;
    Promise.all(refLinks.map(async (l) => {
      // includeInactive so an already-assigned inactive target still renders by name.
      const rows = await api<{ id: string; name: string }[]>(
        `/api/picklists/${l.targetKind}?includeInactive=1`);
      return [l.column, rows] as const;
    }))
      .then((pairs) => setRefOptions(Object.fromEntries(pairs)))
      // No .catch(() => {}) here: a failed fetch that renders an empty dropdown is
      // indistinguishable from a shop that has configured nothing. Say so instead.
      .catch((e) => setError(`Could not load pick lists: ${(e as Error).message}`));
  }, [kind]);
```

Display the resolved name in the row — line ~77 currently reads `String(r[f.key] ?? "")`:

```tsx
{extras.map((f) => (
  <td key={f.key} className="p-2">{String(r[f.kind === "ref" ? nameKey(f.key) : f.key] ?? "")}</td>
))}
```

And in the add-row draft (line ~94), a ref column becomes a select submitting the **name**, with a blank option so a nullable FK can be cleared:

```tsx
{extras.map((f) => (
  <td key={f.key} className="p-2">
    {f.kind === "ref" ? (
      <select value={draft[nameKey(f.key)] ?? ""}
              onChange={(e) => setDraft({ ...draft, [nameKey(f.key)]: e.target.value })}
              className="w-full rounded border px-2 py-1 text-sm">
        <option value="">—</option>
        {(refOptions[f.key] ?? []).map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
      </select>
    ) : (
      <input value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
             className="w-full rounded border px-2 py-1 text-sm" />
    )}
  </td>
))}
```

Read the file before editing and keep its existing class names and `add()` wiring — the draft is already submitted as-is, so submitting the name key is all that changes on the write side.

- [ ] **Step 7: Run all four gates and commit**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add src/server/reference.ts src/server/paste.ts src/components/ReferenceTable.tsx tests/reference-names.test.ts
git commit -m "$(cat <<'EOF'
feat: accept reference foreign keys by name on create, update and paste

Paste for inspectionCode and paymentType required typing a cuid, which made
quick entry unusable for exactly the two kinds that have a foreign key. They
now take the name and resolve it among live rows, erroring per row with the
column label and the offending value.

The grid's ref inputs become selects fed by /api/picklists, and a failed
fetch now surfaces instead of being swallowed into an empty dropdown.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: The reference-delete guard

**Files:**
- Create: `erp/src/server/reference-blockers.ts`
- Modify: `erp/src/server/reference.ts` (`deleteReference`)
- Create: `erp/tests/reference-blockers.test.ts`

**Interfaces:**
- Consumes: `linksTargeting` (Task 1).
- Produces: `findBlockers(kind, id): Promise<Blocker[]>` where `Blocker = { entityLabel: string; name: string; id: string; href: string | null }`. Task 6's UI and export consume it.

- [ ] **Step 1: Write the failing tests**

Create `erp/tests/reference-blockers.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { createReference, deleteReference, listReference } from "@/server/reference";
import { createCustomer, deleteCustomer } from "@/server/customers";
import { createStepCode } from "@/server/process-step-codes";
import { findBlockers } from "@/server/reference-blockers";
import { HttpError } from "@/server/errors";

describe("reference delete guard", () => {
  beforeEach(async () => await truncateAll());

  it("refuses to delete a row something points at, and names what", async () => {
    const terms = await createReference("terms", { name: "Net 30" });
    await createCustomer({ code: "ACME", name: "Acme Foundry", termsId: terms.id });

    await expect(deleteReference("terms", terms.id)).rejects.toThrow(HttpError);
    await expect(deleteReference("terms", terms.id)).rejects.toThrow(/still (in use|used)/i);

    // The row survives — refused, not allowed-and-cleared, not allowed-and-dangled.
    expect((await listReference("terms")).map((r) => r.id)).toContain(terms.id);
  });

  it("lists each blocker with a link where a detail page exists", async () => {
    const terms = await createReference("terms", { name: "Net 30" });
    const c = await createCustomer({ code: "ACME", name: "Acme Foundry", termsId: terms.id });

    expect(await findBlockers("terms", terms.id)).toEqual([
      { entityLabel: "Customer", name: "Acme Foundry", id: c.id, href: `/customers/${c.id}` },
    ]);
  });

  it("gives no href for an entity with no detail page", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    const code = await createStepCode({ code: "HT-01", name: "Austenitize", glAccountId: gl.id });

    expect(await findBlockers("glAccount", gl.id)).toEqual([
      { entityLabel: "Process step code", name: expect.stringContaining("HT-01"), id: code.id, href: null },
    ]);
  });

  it("gathers blockers across every registered link, not just the first", async () => {
    const gl = await createReference("glAccount", { name: "4010" });
    await createStepCode({ code: "HT-01", name: "Austenitize", glAccountId: gl.id });
    await createReference("paymentType", { name: "Check", glAccountId: gl.id });

    const labels = (await findBlockers("glAccount", gl.id)).map((b) => b.entityLabel).sort();
    expect(labels).toEqual(["Payment type", "Process step code"]);
  });

  it("ignores soft-deleted blockers — a deleted customer must not block forever", async () => {
    const terms = await createReference("terms", { name: "Net 30" });
    const c = await createCustomer({ code: "ACME", name: "Acme", termsId: terms.id });
    await deleteCustomer(c.id, "closed the account");

    expect(await findBlockers("terms", terms.id)).toEqual([]);
    await expect(deleteReference("terms", terms.id)).resolves.toBeUndefined();
  });

  it("still deletes a row nothing points at — the guard must not obstruct a typo cleanup", async () => {
    const t = await createReference("terms", { name: "Typo" });
    await expect(deleteReference("terms", t.id)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to watch them fail**

```bash
npx vitest run tests/reference-blockers.test.ts
```
Expected: FAIL — `@/server/reference-blockers` does not exist.

- [ ] **Step 3: Implement blocker discovery**

Create `erp/src/server/reference-blockers.ts`:

```ts
import { prisma } from "./db";
import { linksTargeting } from "../lib/reference-links";
import type { ReferenceKind } from "../lib/reference-constants";

export type Blocker = { entityLabel: string; name: string; id: string; href: string | null };

/** Every LIVE row, across every registered link, whose foreign key holds this reference row's id.
 *
 *  Why this exists rather than just refusing: refusing is only a third of it. This is a live
 *  Visual Shop dead end the owner is escaping — there, a furnace group cannot be deleted because
 *  a process master points at it, and that master cannot be deleted because parts point at it,
 *  with no way to find those parts: "it would take me a year to find them all and point it
 *  elsewhere." A block without discoverability looks like data integrity while actually being a
 *  permanent dead end.
 *
 *  Computed on demand, not cached: blocker sets stay small for years because the system starts
 *  empty, and a stale cache on a data-integrity guard is worse than a query. */
export async function findBlockers(kind: ReferenceKind, id: string): Promise<Blocker[]> {
  const out: Blocker[] = [];
  for (const link of linksTargeting(kind)) {
    const delegate = prisma[link.model] as unknown as {
      findMany: (a: object) => Promise<Record<string, unknown>[]>;
    };
    const rows = await delegate.findMany({
      where: { [link.column]: id, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    for (const row of rows) {
      const rowId = String(row.id);
      // processStepCode's human key is `code`; every other linked model uses `name`.
      const label = typeof row.name === "string" && row.name
        ? (typeof row.code === "string" ? `${row.code} — ${row.name}` : row.name)
        : rowId;
      out.push({
        entityLabel: link.entityLabel,
        name: label,
        id: rowId,
        href: link.detailPath ? link.detailPath(rowId) : null,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Refuse the delete**

In `erp/src/server/reference.ts`, replace `deleteReference`:

```ts
export async function deleteReference(kind: string, id: string): Promise<void> {
  assertKind(kind);
  const blockers = await findBlockers(kind, id);
  if (blockers.length) {
    const label = REFERENCE_LABELS[kind].singular.toLowerCase();
    throw new HttpError(400, `That ${label} is still in use by ${blockers.length} record(s)`);
  }
  await withDbErrors({ entity: REFERENCE_LABELS[kind].singular }, () => auditedSoftDelete(kind, id));
}
```

Import `findBlockers` from `./reference-blockers`.

- [ ] **Step 5: Run the tests, then all four gates and commit**

```bash
npx vitest run tests/reference-blockers.test.ts
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add src/server/reference-blockers.ts src/server/reference.ts tests/reference-blockers.test.ts
git commit -m "$(cat <<'EOF'
feat: refuse to delete a reference row anything still points at

Consistent with deleteCustomer's "still has child customers" and deleteRole's
"still assigned" guards. The refusal carries the blocker list, because
refusing alone reproduces the Visual Shop dead end the owner is escaping: a
block with no way to find what is blocking looks like data integrity while
actually being permanent.

Soft-deleted blockers are ignored — a deleted customer must not block a terms
row forever — and a row nothing points at still deletes, so a typo cleanup is
untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Blocker UI and Excel export

**Files:**
- Create: `erp/src/app/api/admin/reference/[kind]/[id]/blockers/route.ts`
- Create: `erp/src/app/api/admin/reference/[kind]/[id]/blockers/export/route.ts`
- Modify: `erp/src/components/ReferenceTable.tsx`
- Modify: `erp/tests/reference-blockers.test.ts`

**Interfaces:**
- Consumes: `findBlockers` (Task 5), `toXlsx` from `src/server/excel.ts`.
- Produces: `GET .../blockers` → `Blocker[]`; `GET .../blockers/export` → xlsx.

- [ ] **Step 1: Write the failing route tests**

Append to `erp/tests/reference-blockers.test.ts`:

```ts
  it("serves the blocker list to an admin and 403s a non-admin", async () => {
    const terms = await createReference("terms", { name: "Net 30" });
    await createCustomer({ code: "ACME", name: "Acme Foundry", termsId: terms.id });
    const ctx = { params: Promise.resolve({ kind: "terms", id: terms.id }) };

    const { cookie: admin } = await signInWith(["admin.view"]);
    const ok = await blockersRoute(new Request("http://x", { headers: { cookie: admin } }), ctx);
    expect(ok.status).toBe(200);
    expect((await ok.json())[0].entityLabel).toBe("Customer");

    const { cookie: nobody } = await signInWith([]);
    const denied = await blockersRoute(new Request("http://x", { headers: { cookie: nobody } }),
                                       { params: Promise.resolve({ kind: "terms", id: terms.id }) });
    expect(denied.status).toBe(403);
  });

  it("exports the blocker list to Excel", async () => {
    const terms = await createReference("terms", { name: "Net 30" });
    await createCustomer({ code: "ACME", name: "Acme Foundry", termsId: terms.id });

    const cookie = await signInWith(["admin.view"]);
    const res = await blockersExportRoute(new Request("http://x", { headers: { cookie } }),
                                          { params: Promise.resolve({ kind: "terms", id: terms.id }) });
    expect(res.headers.get("content-type")).toContain("spreadsheetml");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const row = wb.getWorksheet(1)!.getRow(2).values as unknown[];
    expect(row).toContain("Customer");
    expect(row).toContain("Acme Foundry");
  });
```

Imports: `ExcelJS from "exceljs"`, `signInWith` from `./helpers/auth`, `GET as blockersRoute` and `GET as blockersExportRoute` from the two new route modules.

- [ ] **Step 2: Run to watch them fail, then implement both routes**

`erp/src/app/api/admin/reference/[kind]/[id]/blockers/route.ts`:

```ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { assertKind } from "@/server/reference";
import { findBlockers } from "@/server/reference-blockers";

export const GET = handle(async (_req, ctx: { params: Promise<{ kind: string; id: string }> }) => {
  mustCan(requireUser(), "admin", "view");
  const { kind, id } = await ctx.params;
  assertKind(kind);
  return NextResponse.json(await findBlockers(kind, id));
});
```

`.../blockers/export/route.ts` — same gate, then:

```ts
  const blockers = await findBlockers(kind, id);
  const buf = await toXlsx("Blockers",
    [{ key: "entityLabel", header: "Type" }, { key: "name", header: "Name" }, { key: "href", header: "Link" }],
    blockers as unknown as Record<string, unknown>[]);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Blockers.xlsx"',
    },
  });
```

- [ ] **Step 3: Wire the UI**

In `erp/src/components/ReferenceTable.tsx`, extend `remove()` so a refused delete fetches and shows the blockers:

```tsx
type Blocker = { entityLabel: string; name: string; id: string; href: string | null };
const [blocked, setBlocked] = useState<{ row: Row; list: Blocker[] } | null>(null);
```

```tsx
  async function remove(row: Row) {
    if (!confirm(`Delete ${labels.singular.toLowerCase()} "${row.name}"?`)) return;
    try {
      await api(`/api/admin/reference/${kind}/${row.id}`, { method: "DELETE" });
      setError(null); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end here: say what is blocking, and make the list exportable.
      const list = await api<Blocker[]>(`/api/admin/reference/${kind}/${row.id}/blockers`)
        .catch(() => [] as Blocker[]);
      if (list.length) { setBlocked({ row, list }); setError(null); }
      else setError((e as Error).message);
    }
  }
```

Render below the grid, and clear it when the kind changes (`useEffect(() => setBlocked(null), [kind])`):

```tsx
{blocked && (
  <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
    <div className="mb-2 font-medium">
      Cannot delete {labels.singular.toLowerCase()} “{blocked.row.name}” — {blocked.list.length} record(s) use it:
    </div>
    <ul className="mb-2 space-y-1">
      {blocked.list.map((b) => (
        <li key={`${b.entityLabel}-${b.id}`}>
          <span className="text-slate-500">{b.entityLabel}</span>{" "}
          {b.href ? <a href={b.href} className="text-blue-700 underline">{b.name}</a> : <span>{b.name}</span>}
        </li>
      ))}
    </ul>
    <div className="flex gap-3">
      <a href={`/api/admin/reference/${kind}/${blocked.row.id}/blockers/export`}
         className="text-blue-700 underline">Export list to Excel</a>
      <button onClick={() => setBlocked(null)} className="text-slate-600">dismiss</button>
    </div>
  </div>
)}
```

Retiring a row that is in use stays possible through the existing **active** toggle — inactive hides it from pick lists while keeping current assignments valid. Do not add wording to the panel suggesting the delete can be forced; it cannot.

- [ ] **Step 4: Run all four gates and commit**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add src/app/api/admin/reference src/components/ReferenceTable.tsx tests/reference-blockers.test.ts
git commit -m "$(cat <<'EOF'
feat: show and export what is blocking a reference delete

Naming no blockers is the actual Visual Shop failure, not the block itself.
The panel links rows whose entity has a detail page and shows the rest as
plain text — only customers have one today, and the admin grids are small and
unpaginated, so the row is already on screen (owner ruling, spec §7.1).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: The permission-gating helper, and its adoption

**Files:**
- Create: `erp/src/lib/permission-ui.ts`
- Create: `erp/tests/permission-ui.test.ts`
- Modify: `erp/src/components/ReferenceTable.tsx`, `erp/src/app/customers/[id]/page.tsx`, `erp/src/app/customers/page.tsx`

**Interfaces:**
- Produces: `gate(perms: string[], key: string): Gate` and `gateDo(perms: string[], special: SpecialAction): Gate`, where `Gate = { allowed: boolean; disabled: boolean; title: string | undefined }`.

- [ ] **Step 1: Write the failing tests**

Create `erp/tests/permission-ui.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { gate, gateDo } from "@/lib/permission-ui";

describe("permission UI gating", () => {
  it("allows what the user holds", () => {
    expect(gate(["customers.delete"], "customers.delete"))
      .toEqual({ allowed: true, disabled: false, title: undefined });
  });

  it("disables and names the missing permission rather than hiding the control", () => {
    // A hidden button is a block with no explanation: the user cannot tell whether the action is
    // missing, broken, or forbidden, and has nothing to ask for.
    expect(gate(["customers.view"], "customers.delete"))
      .toEqual({ allowed: false, disabled: true, title: "Requires customers.delete" });
  });

  it("keys special actions under action.<name>, matching /api/auth/me", () => {
    expect(gateDo(["action.change_prices"], "change_prices").allowed).toBe(true);
    expect(gateDo([], "change_prices"))
      .toEqual({ allowed: false, disabled: true, title: "Requires change_prices" });
  });

  it("treats an absent permission array as no permissions, not as full access", () => {
    // /api/auth/me can be in flight on first render. Failing open would flash live controls.
    expect(gate(undefined, "customers.delete").allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

Create `erp/src/lib/permission-ui.ts`:

```ts
// Pure functions over the flat permission-key array /api/auth/me returns. Client-safe:
// no server imports (importing src/server/** would drag Prisma into the browser bundle).
import type { SpecialAction } from "./permission-constants";

export type Gate = { allowed: boolean; disabled: boolean; title: string | undefined };

function decide(held: string[] | undefined, key: string, label: string): Gate {
  const allowed = (held ?? []).includes(key);
  return { allowed, disabled: !allowed, title: allowed ? undefined : `Requires ${label}` };
}

/** Gate a control on an area permission, e.g. gate(me.permissions, "customers.delete"). */
export function gate(held: string[] | undefined, key: string): Gate {
  return decide(held, key, key);
}

/** Gate on a named special action. /api/auth/me keys these as `action.<name>`, but the tooltip
 *  names the action the way the roles screen does, without the prefix. */
export function gateDo(held: string[] | undefined, special: SpecialAction): Gate {
  return decide(held, `action.${special}`, special);
}
```

- [ ] **Step 3: Adopt it on the customer pages and the reference grid**

Owner ruling: this adoption stays in this branch, because using the helper against a real screen is what proves it before every parts screen depends on it.

Each page already fetches `/api/auth/me`; hold its `permissions` array in state and gate from it. The shape, applied once — repeat it at each site listed below:

```tsx
import { gate } from "@/lib/permission-ui";

const [perms, setPerms] = useState<string[] | undefined>(undefined);
useEffect(() => {
  api<{ permissions: string[] }>("/api/auth/me").then((me) => setPerms(me.permissions))
    .catch((e) => setError((e as Error).message));
}, []);

const canDelete = gate(perms, "customers.delete");
```
```tsx
<button onClick={remove} disabled={canDelete.disabled} title={canDelete.title}
        className="text-sm text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
  Delete customer
</button>
```

`perms` starts `undefined`, and `gate(undefined, …)` denies — so controls render disabled until `/api/auth/me` answers, rather than flashing enabled and then locking.

Sites:

| File | Control | Gate |
|---|---|---|
| `customers/page.tsx` | Add row, Paste from spreadsheet | `customers.create` |
| `customers/[id]/page.tsx` | Delete customer | `customers.delete` |
| `customers/[id]/page.tsx` | add address, add contact, make default | `customers.edit` |
| `components/ReferenceTable.tsx` | add, delete, paste | `admin.edit` |

- **Inputs render `readOnly` when the user lacks the edit permission — never hidden.** A `customers.view`-only user still has to read the name, terms and notes:
  ```tsx
  <input readOnly={!gate(perms, "customers.edit").allowed} className="… read-only:bg-slate-50" … />
  ```
- `Shell.tsx` is untouched: it keeps *hiding* nav entries, and deciding which features exist at all is a different problem from being stopped mid-task.
- Not reachable while the owner is the only user and an admin — it matters the moment a second user exists, which is why the unit tests in Step 1 carry the real assurance here rather than a manual check.

- [ ] **Step 4: Run all four gates and commit**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add src/lib/permission-ui.ts tests/permission-ui.test.ts src/components/ReferenceTable.tsx src/app/customers
git commit -m "$(cat <<'EOF'
feat: gate controls with one shared helper instead of per-page conditionals

A control the user cannot use is disabled and says why, never silently
hidden — a hidden button leaves the user unable to tell whether the action is
missing, broken, or forbidden, and with nothing to ask for. Fields are not a
choice and render read-only instead.

The customer pages and the reference grid adopt it here rather than in 2C-2,
so the helper is proven against real screens before every parts screen
depends on it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `deleteRole` requires a reason

**Files:**
- Modify: `erp/src/server/roles.ts`, `erp/src/app/api/admin/roles/[id]/route.ts`, `erp/src/app/admin/roles/page.tsx`
- Modify: `erp/tests/roles.test.ts`

**Interfaces:**
- Produces: `deleteRole(roleId: string, reason: string): Promise<void>` — a **breaking signature change**; every caller must pass a reason.

- [ ] **Step 1: Write the failing tests**

Append to `erp/tests/roles.test.ts`:

```ts
  it("requires a reason to delete a role", async () => {
    const { id } = await createRole("Shipping");
    await expect(deleteRole(id, "")).rejects.toThrow(/reason is required/i);
    await expect(deleteRole(id, "   ")).rejects.toThrow(/reason is required/i);
  });

  it("stores the trimmed reason on the audit entry", async () => {
    const { id } = await createRole("Shipping");
    await deleteRole(id, "  duplicate of Office  ");
    const [entry] = await readAudit("role", id);
    expect(entry.action).toBe("delete");
    expect(entry.reason).toBe("duplicate of Office");
  });
```

- [ ] **Step 2: Run to watch them fail, then implement**

In `erp/src/server/roles.ts`:

```ts
/**
 * `reason` is required, not optional — spec §9's "destructive-ish actions require a reason".
 * Role delete qualifies on two counts: it carries the role's permission grants away, and it
 * frees the role name for reuse by an unrelated future role. Enforced in the service rather
 * than only at the route so no future caller can bypass it, matching deleteCustomer.
 *
 * Requiring a reason on EVERY delete was considered and rejected (handoff §5.17): demanding a
 * justification for a carrier typed wrong four seconds earlier trains people to type "x".
 */
export async function deleteRole(roleId: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to delete a role");
  const holders = await prisma.user.count({ where: { roleId, deletedAt: null } });
  if (holders > 0) throw new HttpError(400, "That role is still assigned to users");
  await withDbErrors({ entity: "Role" }, () => auditedSoftDelete("role", roleId, why));
}
```

Preserve the existing "still assigned" guard exactly — read the current body before replacing it, and keep whatever guard order it uses.

The DELETE route parses the reason from the body:

```ts
export const DELETE = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  mustCan(requireUser(), "admin", "delete");
  const { id } = await ctx.params;
  const { reason } = z.object({ reason: z.string() }).parse(await req.json());
  await deleteRole(id, reason);
  return NextResponse.json({ ok: true });
});
```

The roles page prompts, mirroring the customer delete — `erp/src/app/admin/roles/page.tsx` line ~35:

```tsx
  async function remove(role: Role) {
    const reason = prompt(`Delete role "${role.name}"?\n\nWhy? (recorded in the audit trail)`);
    // null = cancelled; empty = submitted blank, which the service rejects with a clear message.
    if (reason === null) return;
    try {
      await api(`/api/admin/roles/${role.id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }
```

Distinguishing `null` from `""` matters: cancelling is not an error, but submitting a blank reason must produce the service's message rather than silently doing nothing.

**Check for other callers** before finishing — `grep -rn "deleteRole(" src tests` — and update every one. The signature change is breaking by design, so `tsc` will find them, but the tests need real reasons rather than `""`.

- [ ] **Step 3: Run all four gates and commit**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
git add src/server/roles.ts src/app/api/admin/roles src/app/admin/roles/page.tsx tests/roles.test.ts
git commit -m "$(cat <<'EOF'
feat: require a reason to delete a role

Role delete joins customer delete under handoff §5.17: it carries the role's
permission grants away and frees the role name for reuse. Enforced in the
service, not only the route, so no future caller can bypass it, and trimmed
before storing so whitespace cannot masquerade as a justification.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] All four gates from a clean generated state:

```bash
cd erp && rm -rf prisma/generated .next && npx prisma generate
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```

- [ ] **No schema change happened:**

```bash
git diff main --stat -- prisma/
```
Expected: empty. If a migration appeared, something went wrong — the branch was scoped to none.

- [ ] Both databases still report no pending migrations:

```bash
npx prisma migrate status
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate status
```

- [ ] No soft-swallowed pick-list fetch survives:

```bash
grep -rn "catch(() => {})" src/app src/components | grep -iE "reference|picklist|terms"
```
Expected: no hits.

- [ ] Browser check against the dev database, per handoff §5a's bundled-Chromium recipe: assign Terms to a customer, try to delete that Terms row, confirm the blocker panel names the customer and links to it, and that the Excel export downloads. Clear the fixtures out of `erp` afterwards.
