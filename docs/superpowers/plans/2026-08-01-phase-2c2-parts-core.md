# Phase 2C-2 — Parts Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can key and paste real memorized parts — identity, material, weights, specifications, inspection requirements, pricing with breaks, owner-defined custom fields — with list/detail/export/paste, full audit, and `change_prices` gating; and the branch first closes the two debt items handoff §6 assigns 2C-2 (the audit-transaction gap and the reference-TOCTOU's writer side).

**Architecture:** Debt first (Approach A, owner-approved): Task 1 makes the audited helpers' `tx` **required** so the compiler enumerates and closes every mutation-outside-transaction site; Task 2 builds `assertRefExists` and converts the four existing FK writers to validate their target inside a Serializable transaction. Only then does the schema move (Task 3: six models, one hand-written migration, registry entries + the `include`/`blockerId` blocker extension), followed by services (4–7), routes (8–10), and UI (11–13). Every parts service is therefore born inside the corrected patterns.

**Tech Stack:** Next.js 15.5 · React 19 · Prisma 7.9.1 + `@prisma/adapter-pg` (pinned exactly; `partialIndexes` preview) · PostgreSQL 16 · Vitest 3.2 · zod 4 · exceljs · TypeScript 5.9.3

**Spec:** `docs/superpowers/specs/2026-08-01-phase-2c2-parts-core-design.md` — read it before Task 1. The spec can be wrong; if a task contradicts what you find in the code, stop and report rather than improvising.

## Global Constraints

- **Branch:** `phase-2c2-parts`, cut from `main` at or after the spec commit `3029fb3`.
- **All four gates green at every commit:** `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`. All commands run from `erp/`. Baseline is **304 passing / 0 skipped**.
- **Conventional commits with NO attribution trailer** (owner's instruction 2026-08-01 — branches are squash-merged, so per-commit trailers concatenate N times; attribution goes in the PR body once).
- **Schema changes apply to two databases.** `npx prisma migrate dev` needs a TTY and refuses in this environment. The workflow is: edit `prisma/schema.prisma` → `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script` → read the output **in full** → hand-write it into `prisma/migrations/<timestamp>_<name>/migration.sql` → `npx prisma migrate deploy` → `npx prisma generate` → `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`.
- **Every partial `@@unique(...)` stays on ONE line** — `tests/partial-unique-sweep.test.ts`'s regexes assume it; a wrapped attribute silently voids the guard in both directions.
- **Never `findUnique`/`findUniqueOrThrow`/`upsert`/`update`/`delete` keyed on a live-rows-only unique column** — the generated client still types it unique, so it compiles and hits the soft-deleted row. Use `findFirst({ where: { …, deletedAt: null } })` / `updateMany`. The sweep fails the build on offenders.
- **No revival-on-create, ever** (handoff §5.11). A re-used code/number is a genuinely new row.
- **Every mutation through `auditedCreate`/`auditedUpdate`/`auditedSoftDelete`** — which, after Task 1, **require** a `tx`. Nesting order is always: `withDbErrors` outermost → `prisma.$transaction` → `audited*` → writes on `tx`.
- **Client components must not import from `src/server/**`.** Shared constants live in `src/lib/`.
- **Route handlers stay thin:** `requireUser()` + `mustCan`/`mustDo` first, zod/JSON parse, delegate. Route tests pass ctx: `handler(request, { params: Promise.resolve({ id }) })`.
- **Errors:** `HttpError(400/403/404, message)`, field-anchored messages. Deletion is always soft.
- Tests share one DB; `truncateAll()` in `beforeEach`; never parallelize test files.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `erp/src/server/decimal-field.ts` | The `decimalField` factory (extracted from `customers.ts`) with required/positivity options |
| `erp/src/server/reference-guards.ts` | `assertRefExists(kind, id, tx)` — in-transaction live-target check for registered FK writers |
| `erp/src/server/parts.ts` | Part CRUD, list/search, paste |
| `erp/src/server/part-specifications.ts` | Spec-link child CRUD |
| `erp/src/server/part-inspections.ts` | Inspection-requirement child CRUD |
| `erp/src/server/part-price-breaks.ts` | Price-break child CRUD + LOT rule (add side) |
| `erp/src/server/part-field-defs.ts` | Custom-field definitions CRUD + delete guard/blockers |
| `erp/src/server/part-field-values.ts` | Per-part custom-field values (typed validation, upsert-in-place) |
| `erp/src/lib/part-constants.ts` | `PRICE_PER`, `PART_FIELD_TYPES`, `PRICING_FIELDS`, `PART_PASTE_COLUMNS` — client-safe |
| `erp/src/lib/use-latest.ts` | Stale-response gate: pure `makeLatestGate()` + `useLatest()` hook |
| `erp/src/app/parts/page.tsx` | Parts list |
| `erp/src/app/parts/[id]/page.tsx` + `IdentitySection.tsx`, `SpecsSection.tsx`, `InspectionsSection.tsx`, `PricingSection.tsx`, `CustomFieldsSection.tsx` (same dir) | Part detail, one focused file per section |
| `erp/src/app/admin/part-fields/page.tsx` | Field-def admin grid |
| `erp/src/app/api/parts/**` routes (see Task 8/9) | Parts API |
| `erp/src/app/api/admin/part-fields/**` routes | Field-def admin API |
| Tests: `tests/audit-tx.test.ts`, `tests/reference-guards.test.ts`, `tests/part-blockers.test.ts`, `tests/parts.test.ts`, `tests/part-specifications.test.ts`, `tests/part-inspections.test.ts`, `tests/part-price-breaks.test.ts`, `tests/part-fields.test.ts`, `tests/parts-routes.test.ts`, `tests/parts-paste-export.test.ts`, `tests/customer-child-scoping.test.ts`, `tests/use-latest.test.ts` | |

**Modified**

- `erp/prisma/schema.prisma` + one new migration — six models, two enums, back-relations.
- `erp/src/server/audit.ts` — `tx` required; `AuditableModel` + `SNAPSHOT_INCLUDE` extended.
- `erp/src/server/roles.ts`, `users.ts`, `reference.ts`, `process-step-codes.ts`, `customers.ts`, `customer-contacts.ts` — Task 1 tx conversions; Task 2 `assertRefExists`; Task 10 scoping + parts guard. (`customer-addresses.ts` already passes `tx` everywhere — Task 1 only tightens types.)
- `erp/src/lib/reference-links.ts` — `include`/`blockerId` fields, `part`/`partSpecification`/`partInspection` models, four new entries.
- `erp/src/server/reference-blockers.ts` — include, blockerId, dedupe.
- `erp/tests/reference-links-sweep.test.ts` — the "finds every known reference FK" expected list grows from 4 to 8.
- `erp/src/app/customers/page.tsx` — adopts `useLatest`.
- `erp/src/app/api/customers/[id]/addresses/[addressId]/route.ts`, `.../contacts/[contactId]/route.ts` — pass the URL customer id through for scoping.
- `erp/src/components/Shell.tsx` — only if the Parts nav entry or an admin "Part fields" entry is missing (verify in Task 13).

Why children get one service file each rather than growing `parts.ts`: the customers precedent (`customer-addresses.ts`, `customer-contacts.ts`), and each file stays small enough to hold in context whole.

---

## Task 1: Make the audited helpers' `tx` required, close every call site

The audit-layer transaction gap (handoff §6, issue #9): most callers run mutation and audit insert as two autocommit statements, so an audit-write failure leaves a committed-but-unaudited mutation. Making `tx` non-optional lets `tsc` enumerate every site; converting each also fixes the inverted `withDbErrors`/`audited*` nesting the backlog notes.

**Files:**
- Modify: `erp/src/server/audit.ts`
- Modify: `erp/src/server/roles.ts`, `erp/src/server/users.ts`, `erp/src/server/reference.ts`, `erp/src/server/process-step-codes.ts`, `erp/src/server/customers.ts` (createCustomer only), `erp/src/server/customer-contacts.ts` (addContact only), `erp/src/server/customer-addresses.ts` (types only, if at all)
- Create: `erp/tests/audit-tx.test.ts`

**Interfaces:**
- Consumes: existing `audited*` helpers and all their callers.
- Produces (every later task relies on these exact shapes):
  - `auditedCreate<T extends { id: string }>(model: AuditableModel, data: object, doIt: () => Promise<T>, opts: { tx: Prisma.TransactionClient }): Promise<T>`
  - `auditedUpdate<T>(model: AuditableModel, id: string, doIt: () => Promise<T>, opts: { tx: Prisma.TransactionClient; reason?: string }): Promise<T>`
  - `auditedSoftDelete(model: AuditableModel, id: string, reason: string | undefined, tx: Prisma.TransactionClient): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `erp/tests/audit-tx.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { auditedCreate } from "@/server/audit";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("audited helpers are transactional", () => {
  beforeEach(truncateAll);

  it("rolls the audit row back with the mutation when the transaction aborts", async () => {
    await expect(asSystem(() => prisma.$transaction(async (tx) => {
      await auditedCreate("carrier", { name: "Doomed" }, () =>
        tx.carrier.create({ data: { name: "Doomed" } }), { tx });
      throw new Error("boom");
    }))).rejects.toThrow("boom");

    expect(await prisma.carrier.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { entity: "carrier" } })).toBe(0);
  });

  it("commits the audit row with the mutation when the transaction succeeds", async () => {
    await asSystem(() => prisma.$transaction(async (tx) => {
      await auditedCreate("carrier", { name: "Kept" }, () =>
        tx.carrier.create({ data: { name: "Kept" } }), { tx });
    }));
    expect(await prisma.auditLog.count({ where: { entity: "carrier", action: "create" } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run it — expect a compile-level failure or pass-by-optionality**

Run: `npx vitest run tests/audit-tx.test.ts`
Today `tx` is optional so this may already pass behaviorally — the *real* red bar for this task is Step 4's `tsc` output. Run the test anyway to prove it is well-formed.

- [ ] **Step 3: Tighten the signatures in `audit.ts`**

In `erp/src/server/audit.ts`, change the three helper signatures to the shapes in **Interfaces** above, and replace every `opts?.tx ?? prisma` / `tx ?? prisma` fallback with the now-required value:

```ts
export async function auditedCreate<T extends { id: string }>(
  model: AuditableModel, data: object, doIt: () => Promise<T>, opts: { tx: Prisma.TransactionClient },
): Promise<T> {
  const created = await doIt();
  await write({ entity: model, entityId: created.id, action: "create", after: data }, opts.tx);
  return created;
}

export async function auditedUpdate<T>(
  model: AuditableModel, id: string, doIt: () => Promise<T>,
  opts: { tx: Prisma.TransactionClient; reason?: string },
): Promise<T> {
  const db = opts.tx;
  const before = await snapshot(model, id, db);
  const result = await doIt();
  const after = await snapshot(model, id, db);
  await write({ entity: model, entityId: id, action: "update", before, after, reason: opts.reason }, db);
  return result;
}

export async function auditedSoftDelete(
  model: AuditableModel, id: string, reason: string | undefined, tx: Prisma.TransactionClient,
): Promise<void> {
  const db = tx;
  // …body unchanged from here down…
}
```

Leave `auditSettingChange` alone — `settings.ts` is the documented exception. Keep the `Db` type and the big comment above it; update the comment's last paragraph to say `tx` is now required rather than optional.

- [ ] **Step 4: Let the compiler enumerate the call sites**

Run: `npx tsc --noEmit`
Expected: errors at every `audited*` call not passing `tx` — as of the branch point: `roles.ts` (4 sites), `users.ts` (3), `reference.ts` (create/update — delete already passes `tx`), `process-step-codes.ts` (5), `customers.ts` (`createCustomer`), `customer-contacts.ts` (`addContact`; check `updateContact`/`deleteContact`, which may already pass `tx`). `customer-addresses.ts` should already be clean.

- [ ] **Step 5: Convert every flagged site with the canonical pattern**

The pattern — `withDbErrors` outermost, `$transaction` next, `audited*` inside, **all writes on `tx`** (passing `tx` while `doIt` still writes on bare `prisma` silently reintroduces the snapshot bug the `Db` comment in `audit.ts` describes — from the other side):

```ts
// BEFORE (roles.ts createRole):
const role = await auditedCreate("role", { name }, () =>
  withDbErrors({ entity: "Role", conflictField: "name" }, () =>
    prisma.role.create({ data: { name } })));

// AFTER:
const role = await withDbErrors({ entity: "Role", conflictField: "name" }, () =>
  prisma.$transaction((tx) =>
    auditedCreate("role", { name }, () => tx.role.create({ data: { name } }), { tx })));
```

File-by-file notes:

- **`roles.ts`** — `createRole`, `renameRole`, `setRolePermissions`, `deleteRole` all follow the pattern above (for `deleteRole`: `prisma.$transaction((tx) => auditedSoftDelete("role", roleId, why, tx))` inside its existing `withDbErrors`). `setRolePermissions`' inner deleteMany/createMany move onto `tx`.
- **`users.ts`** — `createUser` and both `auditedUpdate` sites in `updateUser`; move the inner `prisma.user.update` / session-delete statements onto `tx`.
- **`reference.ts`** — give `delegate` a client parameter: `function delegate(kind: ReferenceKind, db: Prisma.TransactionClient = prisma)`. Then:

```ts
const row = await withDbErrors({ entity: REFERENCE_LABELS[kind].singular, conflictField: "name" }, () =>
  prisma.$transaction((tx) =>
    auditedCreate(kind, data, () => delegate(kind, tx).create({ data }), { tx })));
```

  `updateReference` mirrors it. `deleteReference` already runs in a Serializable `$transaction` — only the (already-present) `tx` argument shape changes.
- **`process-step-codes.ts`** — `createStepCode`, `updateStepCode`, `deleteStepCode` follow the pattern. `setStepFields` and `updateStepCodeWithFields` currently invert the nesting (`auditedUpdate` wraps a `prisma.$transaction`); restructure both to the canonical order. Target shape for `updateStepCodeWithFields`:

```ts
await withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
  prisma.$transaction((tx) =>
    auditedUpdate("processStepCode", id, async () => {
      await tx.processStepCode.update({ where: { id }, data });
      if (parsedFields !== undefined) {
        await tx.processStepFieldDef.deleteMany({ where: { codeId: id } });
        await tx.processStepFieldDef.createMany({
          data: parsedFields.map((f) => ({ codeId: id, label: f.label, type: f.type, unit: f.unit ?? null, sort: f.sort })),
        });
      }
    }, { tx })));
```

  `setStepFields` gets the same restructure (keep its exists-check, on `tx`).
- **`customers.ts`** — only `createCustomer` needs wrapping; both `updateCustomer` branches and `deleteCustomer` already pass `{ tx }`/`tx`.
- **`customer-contacts.ts`** — `addContact` needs wrapping; verify the other two already conform.

If any site resists this pattern (nested transactions, a write that can't move onto `tx`), **stop and report** — the plan may be wrong.

- [ ] **Step 6: Run the full gates**

Run: `npx tsc --noEmit && npx vitest run && npx eslint src tests`
Expected: 0 type errors; **all 304 baseline tests plus the 2 new ones pass** (existing tests are the behavioral harness for this refactor); eslint clean. If an existing test fails, the conversion changed behavior — fix the conversion, not the test, unless the test asserted the two-statement gap itself.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor: require tx on audited helpers, close the audit transaction gap"
```

---

## Task 2: `assertRefExists` + Serializable conversion of the four existing FK writers

The TOCTOU's writer side (handoff §6): `deleteReference`'s Serializable wrap closes no live race until each FK writer validates its target **inside the same Serializable transaction as its write**. This also closes a live hole today: assigning a soft-deleted target **by raw id** currently succeeds silently (the FK constraint only rejects hard-missing rows).

**Files:**
- Create: `erp/src/server/reference-guards.ts`
- Modify: `erp/src/server/customers.ts` (retire `assertTermsExists`), `erp/src/server/reference.ts` (create/update), `erp/src/server/process-step-codes.ts` (create/update/updateStepCodeWithFields)
- Create: `erp/tests/reference-guards.test.ts`

**Interfaces:**
- Consumes: `REFERENCE_LABELS` (`src/lib/reference-constants.ts`), Task 1's helper shapes.
- Produces: `assertRefExists(kind: ReferenceKind, id: string, tx: Prisma.TransactionClient): Promise<void>` — throws `HttpError(400, \`That ${label} does not exist\`)` where `label` is `REFERENCE_LABELS[kind].singular.toLowerCase()`. Parts services (Tasks 4–6) call this for every FK assignment.

- [ ] **Step 1: Write the failing tests**

Create `erp/tests/reference-guards.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createCustomer, updateCustomer } from "@/server/customers";
import { createReference, updateReference } from "@/server/reference";
import { createStepCode, updateStepCode } from "@/server/process-step-codes";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("FK writers validate their target in-transaction", () => {
  beforeEach(truncateAll);

  async function deadRow(model: "terms" | "glAccount" | "inspectionScale") {
    const row = await (prisma[model] as { create: (a: object) => Promise<{ id: string }> })
      .create({ data: { name: `dead-${model}`, deletedAt: new Date() } });
    return row.id;
  }

  it("customer.termsId: soft-deleted terms rejected on create and update", async () => {
    const dead = await deadRow("terms");
    await expect(asSystem(() => createCustomer({ code: "A", name: "A", termsId: dead })))
      .rejects.toThrow("That terms does not exist");
    const { id } = await asSystem(() => createCustomer({ code: "B", name: "B" }));
    await expect(asSystem(() => updateCustomer(id, { termsId: dead })))
      .rejects.toThrow("That terms does not exist");
  });

  it("inspectionCode.defaultScaleId: soft-deleted scale rejected even as a raw id", async () => {
    const dead = await deadRow("inspectionScale");
    await expect(asSystem(() => createReference("inspectionCode", { name: "HRC", defaultScaleId: dead })))
      .rejects.toThrow("That inspection scale does not exist");
    const { id } = await asSystem(() => createReference("inspectionCode", { name: "HB" }));
    await expect(asSystem(() => updateReference("inspectionCode", id, { defaultScaleId: dead })))
      .rejects.toThrow("That inspection scale does not exist");
  });

  it("paymentType.glAccountId and processStepCode.glAccountId: same", async () => {
    const dead = await deadRow("glAccount");
    await expect(asSystem(() => createReference("paymentType", { name: "Check", glAccountId: dead })))
      .rejects.toThrow("That gl account does not exist");
    await expect(asSystem(() => createStepCode({ code: "HT-01", name: "Austenitize", glAccountId: dead })))
      .rejects.toThrow("That gl account does not exist");
    const { id } = await asSystem(() => createStepCode({ code: "HT-02", name: "Temper" }));
    await expect(asSystem(() => updateStepCode(id, { glAccountId: dead })))
      .rejects.toThrow("That gl account does not exist");
  });

  it("an INACTIVE target is still assignable — inactive hides, it does not invalidate", async () => {
    const t = await prisma.terms.create({ data: { name: "Net 30", active: false } });
    const { id } = await asSystem(() => createCustomer({ code: "C", name: "C", termsId: t.id }));
    expect(id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify the raw-id cases fail**

Run: `npx vitest run tests/reference-guards.test.ts`
Expected: FAIL — the raw-id assignments currently succeed (or, for terms, throw the old "Those terms do not exist" text from outside any transaction).

- [ ] **Step 3: Implement `reference-guards.ts`**

```ts
import { Prisma } from "../../prisma/generated/prisma/client";
import { HttpError } from "./errors";
import { REFERENCE_LABELS, type ReferenceKind } from "../lib/reference-constants";

/**
 * Rejects an id that is not a LIVE row of the target kind, reading on the caller's own `tx` so
 * the check and the FK write commit or abort together. This is the writer-side half of the
 * reference-delete TOCTOU (handoff §6): deleteReference's blocker scan runs Serializable, and
 * Postgres SSI only aborts a race when the writer's read of the target shares the writer's own
 * Serializable transaction — assertNoCycle (customers.ts) is the precedent shape.
 *
 * `active: false` is deliberately NOT filtered: inactive hides a row from pick lists, it does
 * not invalidate assignment (handoff §5.14).
 */
export async function assertRefExists(
  kind: ReferenceKind, id: string, tx: Prisma.TransactionClient,
): Promise<void> {
  const delegate = tx[kind] as unknown as {
    findFirst: (a: { where: object; select: object }) => Promise<{ id: string } | null>;
  };
  const row = await delegate.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!row) {
    throw new HttpError(400, `That ${REFERENCE_LABELS[kind].singular.toLowerCase()} does not exist`);
  }
}
```

- [ ] **Step 4: Convert the four writers**

All four move their target check inside their (now Serializable) write transaction:

- **`customers.ts`** — delete `assertTermsExists` and both its call sites. `createCustomer` becomes:

```ts
const row = await withDbErrors({ entity: "Customer", conflictField: "code" }, () =>
  prisma.$transaction(async (tx) => {
    if (data.parentId) await assertParentExists(data.parentId, tx);
    if (data.termsId) await assertRefExists("terms", data.termsId, tx);
    return auditedCreate("customer", data, () => tx.customer.create({ data }), { tx });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
```

  (The pre-existing live-duplicate `findFirst` on `code` stays before the transaction — it is a courtesy 400; the partial unique index is the real guard.) In `updateCustomer`, replace the bare `if (data.termsId) await assertTermsExists(...)` with an in-transaction check: fold `termsId` into the same shape the `parentId` branch already has — when the patch carries `termsId` (non-null) or `parentId`, run the Serializable branch and call `assertRefExists("terms", data.termsId, tx)` inside it. A patch touching neither keeps the plain transaction.
  **One existing test will assert the old message "Those terms do not exist" — update it to "That terms does not exist"** (grep `tests/` for the old string; this message unification is intentional).
- **`reference.ts`** — `createReference` / `updateReference` (already transactional after Task 1): make those transactions Serializable and, inside, for each `linksFrom(kind)` column present and non-null in `data`, call `assertRefExists(link.targetKind, data[link.column] as string, tx)`.
- **`process-step-codes.ts`** — in `createStepCode`, `updateStepCode`, and `updateStepCodeWithFields`, inside their transactions (Serializable), when `data.glAccountId` is a non-null string: `await assertRefExists("glAccount", data.glAccountId, tx)`.

Serializable is **scoped to writes that assign a registered FK** (the `updateCustomer` parent-change precedent); `withDbErrors` already maps P2034 to a 409-retry.

- [ ] **Step 5: Run the tests and the full gates**

Run: `npx vitest run tests/reference-guards.test.ts && npx vitest run && npx tsc --noEmit && npx eslint src tests`
Expected: new tests PASS; the one old-message test updated; everything else green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: validate FK targets in-transaction (writer-side TOCTOU fix)"
```

---

## Task 3: Schema — six part models, migration, audit registration, registry entries, blocker extension

Everything declarative lands at once so the sweeps stay green in one commit: the schema, its hand-written migration (both DBs), `AuditableModel`/`SNAPSHOT_INCLUDE`, the four registry entries (the reference-links sweep fails the commit without them), and the `include`/`blockerId`/dedupe extension to `findBlockers` those entries need.

**Files:**
- Modify: `erp/prisma/schema.prisma`; Create: `erp/prisma/migrations/<timestamp>_parts_core/migration.sql`
- Modify: `erp/src/server/audit.ts` (model list + snapshot includes)
- Modify: `erp/src/lib/reference-links.ts`, `erp/src/server/reference-blockers.ts`
- Modify: `erp/tests/reference-links-sweep.test.ts` (known-FK list 4 → 8)
- Create: `erp/tests/part-blockers.test.ts`

**Interfaces:**
- Produces: Prisma models `Part`, `PartSpecification`, `PartInspection`, `PartPriceBreak`, `PartFieldDef`, `PartFieldValue`; enums `PricePer`, `PartFieldType`; `AuditableModel` gains `"part" | "partSpecification" | "partInspection" | "partPriceBreak" | "partFieldDef" | "partFieldValue"`; `ReferenceLink` gains `include?: Record<string, unknown>` and `blockerId?: (row: Record<string, unknown>) => string`.

- [ ] **Step 1: Edit `prisma/schema.prisma`**

Add both enums and all six models exactly as spec §4 declares them (copy from the spec — every partial `@@unique` on one line). Add the back-relations the new FKs require on existing models: `parts Part[]` on `Customer` and on `Material`; `partSpecifications PartSpecification[]` on `Specification`; `partInspections PartInspection[]` on `InspectionCode` and on `InspectionScale`.

- [ ] **Step 2: Generate, hand-write, and apply the migration**

```bash
npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script
```

Read the output **in full**. It must contain: `CREATE TYPE "PricePer"` and `"PartFieldType"`; six `CREATE TABLE`s; partial unique indexes `ON "Part"("customerId","partNumber") WHERE "deletedAt" IS NULL`, `ON "PartSpecification"("partId","specificationId") WHERE "deletedAt" IS NULL`, `ON "PartPriceBreak"("partId","threshold") WHERE "deletedAt" IS NULL`, `ON "PartFieldDef"("name") WHERE "deletedAt" IS NULL`; a plain unique on `"PartFieldValue"("partId","fieldId")`; the plain indexes from the spec; and FKs (required relations `ON DELETE RESTRICT`, optional `ON DELETE SET NULL`, per Prisma defaults — trust the diff output over this sentence, but investigate anything that looks like a drop or rewrite of an existing table, which would mean the schema edit is wrong). Write it to `prisma/migrations/<timestamp>_parts_core/migration.sql` (timestamp format matches the existing directories), then:

```bash
npx prisma migrate deploy
npx prisma generate
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
```

- [ ] **Step 3: Register the models with the audit layer**

In `audit.ts`, extend `AuditableModel` with the six names and `SNAPSHOT_INCLUDE` with:

```ts
part: undefined,                       // children are audited as their own models
partSpecification: { specification: true },   // history reads "ASTM A536", not a cuid
partInspection: { inspectionCode: true, scale: true },
partPriceBreak: undefined,
partFieldDef: undefined,
partFieldValue: { field: true },       // history names the field the value belongs to
```

- [ ] **Step 4: Watch the reference-links sweep fail, then register the four links**

Run: `npx vitest run tests/reference-links-sweep.test.ts`
Expected: FAIL naming `part.materialId -> material`, `partSpecification.specificationId -> specification`, `partInspection.inspectionCodeId -> inspectionCode`, `partInspection.scaleId -> inspectionScale` (this run is the mutation-proof the 2C-1 spec demands — the sweep bit for real). Also update the `finds every known reference FK when nothing is registered` test's expected array to the 8-entry sorted list including those four.

Then in `reference-links.ts`, extend the type and register:

```ts
export type ReferenceLinkModel =
  | "customer" | "processStepCode" | "paymentType" | "inspectionCode"
  | "part" | "partSpecification" | "partInspection";

export type ReferenceLink = {
  // …existing fields unchanged…
  /** Relations the blocker query loads (pure data, client-safe) — a child row that presents
   *  its parent needs the parent (and its customer) on the row displayName reads. */
  include?: Record<string, unknown>;
  /** Which entity this blocker IS. Defaults to the row itself. A child row that presents its
   *  parent (partInspection → part) returns the parent's id; href, detailPath and dedupe all
   *  use it. */
  blockerId?: (row: Record<string, unknown>) => string;
};

/** A Part is (customer, partNumber) — never a bare name (2C-1 spec §9). */
function partLabel(p: unknown): string {
  const part = p as { partNumber?: unknown; customer?: { code?: unknown } };
  return `${String(part.customer?.code ?? "?")} · ${String(part.partNumber ?? "?")}`;
}
const PART_VIA_CHILD = {
  entityLabel: "Part",
  detailPath: (id: string) => `/parts/${id}`,
  include: { part: { select: { id: true, partNumber: true, customer: { select: { code: true } } } } },
  blockerId: (r: Record<string, unknown>) => String((r.part as { id: string }).id),
  displayName: (r: Record<string, unknown>) => partLabel(r.part),
} as const;

// Appended to REFERENCE_LINKS:
{ model: "part", column: "materialId", targetKind: "material",
  label: "Material", entityLabel: "Part", detailPath: (id) => `/parts/${id}`,
  include: { customer: { select: { code: true } } }, displayName: (r) => partLabel(r) },
{ model: "partSpecification", column: "specificationId", targetKind: "specification",
  label: "Specification", ...PART_VIA_CHILD },
{ model: "partInspection", column: "inspectionCodeId", targetKind: "inspectionCode",
  label: "Inspection code", ...PART_VIA_CHILD },
{ model: "partInspection", column: "scaleId", targetKind: "inspectionScale",
  label: "Scale", ...PART_VIA_CHILD },
```

- [ ] **Step 5: Write the failing blocker tests**

Create `erp/tests/part-blockers.test.ts` — fixtures via raw `prisma` (the services don't exist yet):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { findBlockers } from "@/server/reference-blockers";
import { deleteReference } from "@/server/reference";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const material = await prisma.material.create({ data: { name: "Ductile iron" } });
  const code = await prisma.inspectionCode.create({ data: { name: "Brinell" } });
  const scale = await prisma.inspectionScale.create({ data: { name: "HB" } });
  const spec = await prisma.specification.create({ data: { name: "ASTM A536" } });
  const part = await prisma.part.create({ data: {
    customerId: customer.id, partNumber: "12345", eachWeight: "2.5", materialId: material.id,
  } });
  return { customer, material, code, scale, spec, part };
}

describe("parts as blockers", () => {
  beforeEach(truncateAll);

  it("a part blocking its material shows CODE · partNumber linked to the part", async () => {
    const { material, part } = await fixture();
    const blockers = await findBlockers("material", material.id);
    expect(blockers).toEqual([
      { entityLabel: "Part", name: "ACME · 12345", id: part.id, href: `/parts/${part.id}` },
    ]);
  });

  it("two inspection rows on one code dedupe to one part blocker", async () => {
    const { code, part } = await fixture();
    await prisma.partInspection.createMany({ data: [
      { partId: part.id, inspectionCodeId: code.id, sort: 0, location: "flange OD" },
      { partId: part.id, inspectionCodeId: code.id, sort: 1, location: "hub" },
    ] });
    const blockers = await findBlockers("inspectionCode", code.id);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ entityLabel: "Part", name: "ACME · 12345", id: part.id });
  });

  it("scale and specification links present the part too", async () => {
    const { scale, spec, part } = await fixture();
    await prisma.partInspection.create({ data: { partId: part.id, inspectionCodeId:
      (await prisma.inspectionCode.create({ data: { name: "Rockwell" } })).id, scaleId: scale.id, sort: 0 } });
    await prisma.partSpecification.create({ data: { partId: part.id, specificationId: spec.id } });
    expect((await findBlockers("inspectionScale", scale.id))[0].name).toBe("ACME · 12345");
    expect((await findBlockers("specification", spec.id))[0].name).toBe("ACME · 12345");
  });

  it("a soft-deleted child row no longer blocks", async () => {
    const { spec, part } = await fixture();
    await prisma.partSpecification.create({
      data: { partId: part.id, specificationId: spec.id, deletedAt: new Date() } });
    expect(await findBlockers("specification", spec.id)).toEqual([]);
  });

  it("deleteReference refuses while a part points at the row", async () => {
    const { material } = await fixture();
    await expect(asSystem(() => deleteReference("material", material.id)))
      .rejects.toThrow("still in use by 1 record(s)");
  });
});
```

Run: `npx vitest run tests/part-blockers.test.ts` — Expected: FAIL (`findBlockers` doesn't yet include relations or dedupe; the child-link entries return the child's id).

- [ ] **Step 6: Extend `findBlockers`**

In `reference-blockers.ts`, inside the loop over `linksTargeting(kind)`:

```ts
const rows = await delegate.findMany({
  where: { [link.column]: id, deletedAt: null },
  orderBy: { createdAt: "asc" },
  ...(link.include ? { include: link.include } : {}),
});
```

and replace the row loop's body with identity-aware, deduped emission (one `seen` set for the whole call — a part reachable through two links of one kind must still list once):

```ts
const seen = new Set<string>();   // declared once, above the links loop
// …
for (const row of rows) {
  const blockerId = link.blockerId ? link.blockerId(row) : String(row.id);
  const key = `${link.entityLabel}:${blockerId}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const label = link.displayName?.(row)
    ?? (typeof row.name === "string" && row.name ? row.name : blockerId);
  out.push({
    entityLabel: link.entityLabel,
    name: label,
    id: blockerId,
    href: link.detailPath ? link.detailPath(blockerId) : null,
  });
}
```

All three registered part models (`part`, `partSpecification`, `partInspection`) carry `deletedAt`, so the existing `deletedAt: null` filter stands unchanged. (`PartFieldValue` has no `deletedAt`, but it is not a registered link.) The cascade in Task 4's `deletePart` is what guarantees a live child never points out of a dead part.

- [ ] **Step 7: Run everything**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src tests && npm run build`
Expected: all green, including both sweeps and the new blocker tests.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: parts schema, audit registration, FK registry entries, blocker extension"
```

---

## Task 4: `decimal-field.ts` + the parts core service

**Files:**
- Create: `erp/src/server/decimal-field.ts`; Modify: `erp/src/server/customers.ts` (import from it, delete the local copy)
- Create: `erp/src/lib/part-constants.ts`
- Create: `erp/src/server/parts.ts`
- Create: `erp/tests/parts.test.ts`

**Interfaces:**
- Consumes: `assertRefExists` (Task 2), Task 1 helper shapes, Task 3 models.
- Produces:
  - `decimalField(precision: number, scale: number, opts?: { required?: boolean; min?: "positive" | "nonnegative" })` — zod pipeline; optional+nullable by default, exactly today's behavior when `opts` is omitted.
  - `src/lib/part-constants.ts`: `PRICE_PER = ["EACH","LB","PER_100","PER_1000","LOT"] as const`, `PricePerValue`, `PART_FIELD_TYPES = ["TEXT","NUMBER","DATE","CHECKBOX"] as const`, `PartFieldTypeValue`, `PRICING_FIELDS = ["setupCharge","unitPrice","minimumCharge","pricePer"] as const`, `PART_PASTE_COLUMNS` (Task 9's list — declare it now, in one place).
  - `parts.ts`: `PartRow` (shape below), `listParts(opts?: { includeInactive?: boolean; search?: string }): Promise<PartRow[]>`, `getPart(id): Promise<PartRow>`, `createPart(input: Record<string, unknown>): Promise<{ id: string }>`, `updatePart(id, input): Promise<void>`, `deletePart(id, reason: string): Promise<void>`.

```ts
export type PartRow = {
  id: string; customerId: string; customerCode: string; customerName: string;
  partNumber: string; name: string; description: string;
  materialId: string | null; materialName: string | null;
  eachWeight: number; loadQty: number | null; loadWeight: number | null;
  serializationRequired: boolean;
  setupCharge: number | null; unitPrice: number | null; minimumCharge: number | null;
  pricePer: PricePerValue; active: boolean;
};
```

- [ ] **Step 1: Extract `decimal-field.ts` (behavior-preserving first)**

```ts
import { z } from "zod";

/** See customers.ts's original comment block (moved here verbatim): precision/scale must match
 *  the column's own @db.Decimal(precision, scale) exactly — the regex bounds integer digits to
 *  precision-scale and fractional digits to scale, so a passing value can neither overflow the
 *  column nor lose precision to silent rounding. */
export function decimalField(
  precision: number, scale: number,
  opts?: { required?: boolean; min?: "positive" | "nonnegative" },
) {
  const intDigits = precision - scale;
  const pattern = new RegExp(`^-?\\d{1,${intDigits}}(\\.\\d{1,${scale}})?$`);
  const message =
    `Must be a decimal with at most ${intDigits} digit${intDigits === 1 ? "" : "s"} before ` +
    `and ${scale} digit${scale === 1 ? "" : "s"} after the decimal point`;
  const base = z.union([z.number(), z.string()]);
  const shaped = opts?.required ? base : base.nullable().optional();
  return shaped.transform((value, ctx) => {
    if (value === null || value === undefined) return value as null | undefined;
    const raw = typeof value === "number" ? String(value) : value.trim();
    if (!pattern.test(raw)) { ctx.addIssue({ code: z.ZodIssueCode.custom, message }); return z.NEVER; }
    const n = Number(raw);
    if (opts?.min === "positive" && n <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be greater than zero" }); return z.NEVER;
    }
    if (opts?.min === "nonnegative" && n < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must not be negative" }); return z.NEVER;
    }
    return n;
  });
}
```

In `customers.ts`, delete the local `decimalField` and its `creditLimitField`/`financeChargeRateField` stay as `decimalField(12, 2)` / `decimalField(6, 4)` imported from `./decimal-field`. Move the explanatory comment with the function. Run the full suite — behavior identical.

- [ ] **Step 2: Write `part-constants.ts`**

```ts
// Pure constants — safe to import from client components (no server imports).
export const PRICE_PER = ["EACH", "LB", "PER_100", "PER_1000", "LOT"] as const;
export type PricePerValue = (typeof PRICE_PER)[number];
export const PRICE_PER_LABELS: Record<PricePerValue, string> = {
  EACH: "Each", LB: "Per lb", PER_100: "Per 100", PER_1000: "Per 1,000", LOT: "Lot (flat)",
};

export const PART_FIELD_TYPES = ["TEXT", "NUMBER", "DATE", "CHECKBOX"] as const;
export type PartFieldTypeValue = (typeof PART_FIELD_TYPES)[number];

/** Fields whose presence in a patch demands the change_prices special action (spec §7). */
export const PRICING_FIELDS = ["setupCharge", "unitPrice", "minimumCharge", "pricePer"] as const;

/** Column order for spreadsheet paste (Task 9), and the header hint above the paste box. */
export const PART_PASTE_COLUMNS = [
  "customerCode", "partNumber", "name", "description", "materialName",
  "eachWeight", "loadQty", "loadWeight", "serializationRequired",
  "setupCharge", "unitPrice", "minimumCharge", "pricePer",
] as const;
```

- [ ] **Step 3: Write the failing tests**

Create `erp/tests/parts.test.ts` (all service calls wrapped in the same `asSystem` helper used in Task 2's tests):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createPart, updatePart, deletePart, getPart, listParts } from "@/server/parts";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function twoCustomers() {
  const acme = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const beta = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  return { acme, beta };
}

describe("parts core", () => {
  beforeEach(truncateAll);

  it("creates with required fields and lists with customer + material names resolved", async () => {
    const { acme } = await twoCustomers();
    const mat = await prisma.material.create({ data: { name: "Ductile iron" } });
    await asSystem(() => createPart({
      customerId: acme.id, partNumber: "12345", eachWeight: "2.5000", materialId: mat.id,
    }));
    const rows = await listParts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partNumber: "12345", customerCode: "ACME", customerName: "Acme Foundry",
      materialName: "Ductile iron", eachWeight: 2.5, pricePer: "EACH", active: true,
    });
  });

  it("same part number coexists under two customers; duplicate under one 400s", async () => {
    const { acme, beta } = await twoCustomers();
    await asSystem(() => createPart({ customerId: acme.id, partNumber: "12345", eachWeight: 1 }));
    await asSystem(() => createPart({ customerId: beta.id, partNumber: "12345", eachWeight: 1 }));
    expect(await prisma.part.count()).toBe(2);
    await expect(asSystem(() => createPart({ customerId: acme.id, partNumber: "12345", eachWeight: 1 })))
      .rejects.toThrow("A part with that part number already exists for that customer");
  });

  it("delete-then-rekey creates a genuinely new row with fresh history (no revival)", async () => {
    const { acme } = await twoCustomers();
    const { id: first } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "77", eachWeight: 1 }));
    await asSystem(() => deletePart(first, "typo"));
    const { id: second } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "77", eachWeight: 2 }));
    expect(second).not.toBe(first);
    const history = await prisma.auditLog.findMany({ where: { entity: "part", entityId: second } });
    expect(history.map((h) => h.action)).toEqual(["create"]);
  });

  it("eachWeight must be > 0 and fit Decimal(10,4); prices carry 4 decimals", async () => {
    const { acme } = await twoCustomers();
    await expect(asSystem(() => createPart({ customerId: acme.id, partNumber: "A", eachWeight: 0 })))
      .rejects.toThrow("Must be greater than zero");
    await expect(asSystem(() => createPart({ customerId: acme.id, partNumber: "A", eachWeight: "1.00001" })))
      .rejects.toThrow("4 digits after the decimal point");
    const { id } = await asSystem(() => createPart({
      customerId: acme.id, partNumber: "A", eachWeight: "0.0500", unitPrice: "0.0575", pricePer: "LB",
    }));
    expect((await getPart(id)).unitPrice).toBe(0.0575);
  });

  it("customerId is immutable after create", async () => {
    const { acme, beta } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "M1", eachWeight: 1 }));
    await expect(asSystem(() => updatePart(id, { customerId: beta.id })))
      .rejects.toThrow("A part cannot move to another customer");
  });

  it("materialId must reference a live material, on create and update", async () => {
    const { acme } = await twoCustomers();
    const dead = await prisma.material.create({ data: { name: "Gone", deletedAt: new Date() } });
    await expect(asSystem(() => createPart({
      customerId: acme.id, partNumber: "X", eachWeight: 1, materialId: dead.id,
    }))).rejects.toThrow("That material does not exist");
  });

  it("switching pricePer to LOT with live breaks is refused", async () => {
    const { acme } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "L", eachWeight: 1 }));
    await prisma.partPriceBreak.create({ data: { partId: id, threshold: "500", price: "0.95" } });
    await expect(asSystem(() => updatePart(id, { pricePer: "LOT" })))
      .rejects.toThrow("delete the price breaks first");
  });

  it("delete requires a reason and cascades children in one transaction", async () => {
    const { acme } = await twoCustomers();
    const spec = await prisma.specification.create({ data: { name: "ASTM A536" } });
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "D", eachWeight: 1 }));
    await prisma.partSpecification.create({ data: { partId: id, specificationId: spec.id } });
    await expect(asSystem(() => deletePart(id, "  "))).rejects.toThrow("A reason is required");
    await asSystem(() => deletePart(id, "keyed wrong"));
    expect((await prisma.part.findFirst({ where: { id } }))!.deletedAt).not.toBeNull();
    expect((await prisma.partSpecification.findFirst({ where: { partId: id } }))!.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({ where: { entity: "part", entityId: id, action: "delete" } });
    expect(entry!.reason).toBe("keyed wrong");
  });

  it("search matches part number, customer code, and customer name", async () => {
    const { acme, beta } = await twoCustomers();
    await asSystem(() => createPart({ customerId: acme.id, partNumber: "GEAR-9", eachWeight: 1 }));
    await asSystem(() => createPart({ customerId: beta.id, partNumber: "PIN-1", eachWeight: 1 }));
    expect((await listParts({ search: "gear" })).map((p) => p.partNumber)).toEqual(["GEAR-9"]);
    expect((await listParts({ search: "beta" })).map((p) => p.partNumber)).toEqual(["PIN-1"]);
    expect((await listParts({ search: "ACME" })).map((p) => p.partNumber)).toEqual(["GEAR-9"]);
  });

  it("update audit entries carry a real diff", async () => {
    const { acme } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "AU", eachWeight: 1 }));
    await asSystem(() => updatePart(id, { name: "Ring gear" }));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "part", entityId: id, action: "update" } });
    const before = entry!.before as { name: string }; const after = entry!.after as { name: string };
    expect(before.name).toBe(""); expect(after.name).toBe("Ring gear");
  });

  it("inactive parts hide by default and appear with includeInactive", async () => {
    const { acme } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "IN", eachWeight: 1 }));
    await asSystem(() => updatePart(id, { active: false }));
    expect(await listParts()).toHaveLength(0);
    expect(await listParts({ includeInactive: true })).toHaveLength(1);
  });
});
```

Run: `npx vitest run tests/parts.test.ts` — Expected: FAIL (module doesn't exist).

- [ ] **Step 4: Implement `parts.ts`**

```ts
import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { PRICE_PER, type PricePerValue } from "../lib/part-constants";

export type PartRow = { /* exactly the Interfaces shape */ };

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

// Kept in sync with prisma/schema.prisma's @db.Decimal declarations on Part.
const FIELDS = {
  partNumber: z.string().trim().min(1).max(60),
  name: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  materialId: z.string().nullable().optional(),
  eachWeight: decimalField(10, 4, { required: true, min: "positive" }),
  loadQty: z.number().int().min(1).nullable().optional(),
  loadWeight: decimalField(10, 2, { min: "positive" }),
  serializationRequired: z.boolean().optional(),
  setupCharge: decimalField(12, 2, { min: "nonnegative" }),
  unitPrice: decimalField(12, 4, { min: "nonnegative" }),
  minimumCharge: decimalField(12, 2, { min: "nonnegative" }),
  pricePer: z.enum(PRICE_PER).optional(),
  active: z.boolean().optional(),
};
const CREATE = z.object({ customerId: z.string().min(1), ...FIELDS }).strict();
const UPDATE = z.object(FIELDS).partial().strict();   // no customerId — immutable by design

const SELECT = {
  id: true, customerId: true, partNumber: true, name: true, description: true,
  materialId: true, eachWeight: true, loadQty: true, loadWeight: true,
  serializationRequired: true, setupCharge: true, unitPrice: true, minimumCharge: true,
  pricePer: true, active: true,
  customer: { select: { code: true, name: true } },
  material: { select: { name: true } },
} as const;

type Raw = Prisma.PartGetPayload<{ select: typeof SELECT }>;
function toRow(r: Raw): PartRow {
  const { customer, material, eachWeight, loadWeight, setupCharge, unitPrice, minimumCharge, ...rest } = r;
  return {
    ...rest, customerCode: customer.code, customerName: customer.name,
    materialName: material?.name ?? null,
    eachWeight: eachWeight.toNumber(), loadWeight: num(loadWeight),
    setupCharge: num(setupCharge), unitPrice: num(unitPrice), minimumCharge: num(minimumCharge),
    pricePer: r.pricePer as PricePerValue,
  };
}

export async function listParts(opts?: { includeInactive?: boolean; search?: string }): Promise<PartRow[]> {
  const q = opts?.search?.trim();
  const rows = await prisma.part.findMany({
    where: {
      deletedAt: null,
      ...(opts?.includeInactive ? {} : { active: true }),
      ...(q ? { OR: [
        { partNumber: { contains: q, mode: "insensitive" } },
        { customer: { code: { contains: q, mode: "insensitive" } } },
        { customer: { name: { contains: q, mode: "insensitive" } } },
      ] } : {}),
    },
    select: SELECT,
    orderBy: [{ customer: { code: "asc" } }, { partNumber: "asc" }],
  });
  return rows.map(toRow);
}

export async function getPart(id: string): Promise<PartRow> {
  const row = await prisma.part.findFirst({ where: { id, deletedAt: null }, select: SELECT });
  if (!row) throw new HttpError(404, "Part not found");
  return toRow(row);
}

export async function createPart(input: Record<string, unknown>): Promise<{ id: string }> {
  const data = CREATE.parse(input);

  // Courtesy 400 for the ordinary case; the partial unique index is the real guard, and its
  // P2002 maps through withDbErrors below for the race case. findFirst, never findUnique.
  const dupe = await prisma.part.findFirst({
    where: { customerId: data.customerId, partNumber: data.partNumber, deletedAt: null },
    select: { id: true },
  });
  if (dupe) throw new HttpError(400, "A part with that part number already exists for that customer");

  const row = await withDbErrors({ entity: "Part", conflictField: "part number" }, () =>
    prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: data.customerId, deletedAt: null }, select: { id: true } });
      if (!customer) throw new HttpError(400, "That customer does not exist");
      if (data.materialId) await assertRefExists("material", data.materialId, tx);
      return auditedCreate("part", data, () => tx.part.create({ data }), { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  return { id: row.id };
}

/** Writes only if still live, one statement — the claimLiveAndUpdate precedent (customers.ts). */
async function claimLive(tx: Prisma.TransactionClient, id: string, data: Prisma.PartUpdateManyMutationInput) {
  const { count } = await tx.part.updateMany({ where: { id, deletedAt: null }, data });
  if (count === 0) throw new HttpError(404, "Part not found");
}

export async function updatePart(id: string, input: Record<string, unknown>): Promise<void> {
  if ("customerId" in input) {
    throw new HttpError(400,
      "A part cannot move to another customer — deactivate it and key a new part instead");
  }
  const data = UPDATE.parse(input);
  const current = await prisma.part.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Part not found");

  // Serializable only where a cross-row invariant exists: a materialId assignment (pairs with
  // deleteReference's blocker scan) or a pricePer change (pairs with addPartBreak's LOT check).
  const needsSerializable = data.materialId != null || data.pricePer !== undefined;
  const iso = needsSerializable
    ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined;

  await withDbErrors({ entity: "Part", conflictField: "part number" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.materialId) await assertRefExists("material", data.materialId, tx);
      if (data.pricePer === "LOT") {
        const breaks = await tx.partPriceBreak.count({ where: { partId: id, deletedAt: null } });
        if (breaks > 0) {
          throw new HttpError(400,
            "A LOT-priced part cannot carry price breaks — delete the price breaks first");
        }
      }
      await auditedUpdate("part", id, () => claimLive(tx, id, data), { tx });
    }, iso));
}

export async function deletePart(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to delete a part");
  const current = await prisma.part.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Part not found");

  await withDbErrors({ entity: "Part" }, () => prisma.$transaction(async (tx) => {
    const [specs, inspections, breaks] = await Promise.all([
      tx.partSpecification.findMany({ where: { partId: id, deletedAt: null }, select: { id: true } }),
      tx.partInspection.findMany({ where: { partId: id, deletedAt: null }, select: { id: true } }),
      tx.partPriceBreak.findMany({ where: { partId: id, deletedAt: null }, select: { id: true } }),
    ]);
    for (const s of specs) await auditedSoftDelete("partSpecification", s.id, "parent part deleted", tx);
    for (const i of inspections) await auditedSoftDelete("partInspection", i.id, "parent part deleted", tx);
    for (const b of breaks) await auditedSoftDelete("partPriceBreak", b.id, "parent part deleted", tx);
    await auditedSoftDelete("part", id, why, tx);
  }));
}
```

(`pasteParts` is Task 9 — do not write it yet.)

- [ ] **Step 5: Run tests, then all gates**

Run: `npx vitest run tests/parts.test.ts` then `npx vitest run && npx tsc --noEmit && npx eslint src tests`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: parts core service with shared decimal validation"
```

---

## Task 5: Specification and inspection child services

**Files:**
- Create: `erp/src/server/part-specifications.ts`, `erp/src/server/part-inspections.ts`
- Create: `erp/tests/part-specifications.test.ts`, `erp/tests/part-inspections.test.ts`

**Interfaces:**
- Consumes: `assertRefExists`, Task 3 models, Task 4's part fixtures pattern.
- Produces:
  - `listPartSpecs(partId): Promise<{ id: string; specificationId: string; specificationName: string }[]>`
  - `addPartSpec(partId: string, specificationId: string): Promise<{ id: string }>`
  - `removePartSpec(partId: string, linkId: string): Promise<void>`
  - `listPartInspections(partId): Promise<InspectionRow[]>` where `InspectionRow = { id: string; inspectionCodeId: string; inspectionCodeName: string; scaleId: string | null; scaleName: string | null; min: number | null; max: number | null; location: string; sort: number }`
  - `addPartInspection(partId, input): Promise<{ id: string }>`, `updatePartInspection(partId, inspId, input): Promise<void>`, `deletePartInspection(partId, inspId): Promise<void>`

Every child read/write filters `{ partId, deletedAt: null }` — **scoping lives in the service**, so no route can reach another part's child (the defect handoff §6 flags on customer children, fixed at birth here).

- [ ] **Step 1: Write the failing spec-link tests**

`erp/tests/part-specifications.test.ts` (same `asSystem` + fixture helpers as Task 4):

```ts
// Cases, each a real it() with the assertions shown:
it("adds a spec and lists it with its name")                    // addPartSpec → listPartSpecs[0].specificationName === "ASTM A536"
it("rejects a soft-deleted specification")                       // rejects.toThrow("That specification does not exist")
it("rejects a duplicate live link")                              // second addPartSpec same spec → rejects.toThrow("already on this part")
it("remove-then-re-add works (partial unique on live rows)")     // removePartSpec, addPartSpec again → new link id, list shows one
it("scopes to the part: removing via the wrong partId 404s")     // removePartSpec(otherPart.id, linkId) → rejects.toThrow("not found")
it("audits add and remove as partSpecification entries")         // auditLog entities "partSpecification", actions ["create","delete"]
it("add to a deleted part 404s")                                 // deletePart first → addPartSpec → rejects.toThrow("Part not found")
```

- [ ] **Step 2: Implement `part-specifications.ts`**

```ts
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";

async function assertPartLive(partId: string, tx: Prisma.TransactionClient): Promise<void> {
  const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
  if (!part) throw new HttpError(404, "Part not found");
}

export async function listPartSpecs(partId: string) {
  const rows = await prisma.partSpecification.findMany({
    where: { partId, deletedAt: null },
    include: { specification: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ id: r.id, specificationId: r.specificationId, specificationName: r.specification.name }));
}

export async function addPartSpec(partId: string, specificationId: string): Promise<{ id: string }> {
  const row = await withDbErrors({ entity: "Specification link", conflictField: "specification" }, () =>
    prisma.$transaction(async (tx) => {
      await assertPartLive(partId, tx);
      await assertRefExists("specification", specificationId, tx);
      const dupe = await tx.partSpecification.findFirst({
        where: { partId, specificationId, deletedAt: null }, select: { id: true } });
      if (dupe) throw new HttpError(400, "That specification is already on this part");
      return auditedCreate("partSpecification", { partId, specificationId }, () =>
        tx.partSpecification.create({ data: { partId, specificationId } }), { tx });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  return { id: row.id };
}

export async function removePartSpec(partId: string, linkId: string): Promise<void> {
  const current = await prisma.partSpecification.findFirst({
    where: { id: linkId, partId, deletedAt: null }, select: { id: true } });
  if (!current) throw new HttpError(404, "Specification link not found");
  await withDbErrors({ entity: "Specification link" }, () =>
    prisma.$transaction((tx) => auditedSoftDelete("partSpecification", linkId, undefined, tx)));
}
```

Run the spec tests: green.

- [ ] **Step 3: Write the failing inspection tests**

`erp/tests/part-inspections.test.ts`:

```ts
it("adds a row and lists in sort order with code and scale names")   // two rows sorts [0,1], names resolved
it("scale is optional; min/max are optional decimals(10,4)")         // row with only code+sort saves; min "28", max "32" round-trip as numbers
it("min > max is a field-anchored 400")                              // rejects.toThrow("min cannot exceed max")
it("rejects soft-deleted code and scale")                            // "That inspection code does not exist" / "That inspection scale does not exist"
it("same code twice with different locations is allowed")            // both rows listed
it("update and delete scope to the part")                            // updatePartInspection(wrongPart, id, …) → "not found"; same for delete
it("audits as partInspection with a real diff on update")            // before.location "" → after.location "flange OD"
```

- [ ] **Step 4: Implement `part-inspections.ts`**

Shape mirrors `part-specifications.ts`. The zod schema:

```ts
const FIELDS = {
  inspectionCodeId: z.string().min(1),
  scaleId: z.string().nullable().optional(),
  min: decimalField(10, 4),
  max: decimalField(10, 4),
  location: z.string().max(200).optional(),
  sort: z.number().int().min(0),
};
const ADD = z.object(FIELDS).strict().superRefine((v, ctx) => {
  if (v.min != null && v.max != null && v.min > v.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["min"], message: "min cannot exceed max" });
  }
});
const EDIT = z.object(FIELDS).partial().strict();  // min/max cross-check re-run against merged values in the service
```

`addPartInspection`: Serializable tx → `assertPartLive` → `assertRefExists("inspectionCode", …)` → if `scaleId` non-null `assertRefExists("inspectionScale", …)` → `auditedCreate`. `updatePartInspection(partId, inspId, input)`: parse EDIT; load current via `findFirst({ id: inspId, partId, deletedAt: null })` (404 otherwise); merge current+patch and re-check min≤max (field-anchored 400 "min cannot exceed max"); Serializable tx when the patch touches `inspectionCodeId`/`scaleId`, plain otherwise; in-tx asserts; `auditedUpdate` with a claim-live `updateMany({ where: { id: inspId, partId, deletedAt: null } })`. `deletePartInspection`: scoped findFirst → `auditedSoftDelete` in a tx. `listPartInspections`: `include: { inspectionCode: { select: { name: true } }, scale: { select: { name: true } } }`, `orderBy: { sort: "asc" }`, decimals via `.toNumber()`.

- [ ] **Step 5: Run all gates, commit**

```bash
npx vitest run && npx tsc --noEmit && npx eslint src tests
git add -A && git commit -m "feat: part specification and inspection child services"
```

---## Task 6: Price-break service and the LOT rule's add side

**Files:**
- Create: `erp/src/server/part-price-breaks.ts`
- Create: `erp/tests/part-price-breaks.test.ts`

**Interfaces:**
- Produces: `listPartBreaks(partId): Promise<{ id: string; threshold: number; price: number }[]>` (threshold asc), `addPartBreak(partId, input): Promise<{ id: string }>`, `updatePartBreak(partId, breakId, input): Promise<void>`, `deletePartBreak(partId, breakId): Promise<void>`. Input schema: `{ threshold: decimalField(12, 2, { required: true, min: "positive" }), price: decimalField(12, 4, { required: true, min: "nonnegative" }) }`.

- [ ] **Step 1: Failing tests**

```ts
it("adds breaks and lists them threshold-ascending")               // add 500 then 100 → list [100, 500]
it("rejects a second live break on the same threshold")            // rejects.toThrow("A price break with that threshold already exists")
it("delete-then-reuse a threshold works (partial unique)")         // new row id
it("refuses a break on a LOT-priced part")                          // rejects.toThrow("A LOT-priced part cannot carry price breaks")
it("threshold must be > 0; price accepts 4 decimals ≥ 0")           // 0 threshold → "Must be greater than zero"; price "0.0475" round-trips
it("scopes update/delete to the part")                              // wrong partId → "Price break not found"
it("audits as partPriceBreak")                                      // create/update/delete entries exist with real diffs
```

- [ ] **Step 2: Implement**

`addPartBreak` runs Serializable (it **reads** `part.pricePer` and **writes** a break — the write-skew partner of `updatePart`'s LOT check, which reads breaks and writes the part; both Serializable is what lets Postgres abort the interleaving that would produce a LOT part with breaks):

```ts
const row = await withDbErrors({ entity: "Price break", conflictField: "threshold" }, () =>
  prisma.$transaction(async (tx) => {
    const part = await tx.part.findFirst({
      where: { id: partId, deletedAt: null }, select: { pricePer: true } });
    if (!part) throw new HttpError(404, "Part not found");
    if (part.pricePer === "LOT") {
      throw new HttpError(400, "A LOT-priced part cannot carry price breaks");
    }
    const dupe = await tx.partPriceBreak.findFirst({
      where: { partId, threshold: data.threshold, deletedAt: null }, select: { id: true } });
    if (dupe) throw new HttpError(400, "A price break with that threshold already exists");
    return auditedCreate("partPriceBreak", { partId, ...data }, () =>
      tx.partPriceBreak.create({ data: { partId, ...data } }), { tx });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
```

`updatePartBreak` re-runs the duplicate-threshold check when `threshold` changes (same tx); `deletePartBreak` is the scoped findFirst + `auditedSoftDelete` shape from Task 5.

- [ ] **Step 3: Gates, commit**

```bash
npx vitest run && npx tsc --noEmit && npx eslint src tests
git add -A && git commit -m "feat: part price breaks with the LOT exclusion"
```

---

## Task 7: Custom-field definitions and values

**Files:**
- Create: `erp/src/server/part-field-defs.ts`, `erp/src/server/part-field-values.ts`
- Create: `erp/tests/part-fields.test.ts`

**Interfaces:**
- Produces:
  - `listPartFieldDefs(opts?: { includeInactive?: boolean }): Promise<{ id; name; type; sort; active }[]>` (sort asc)
  - `createPartFieldDef(input)`, `updatePartFieldDef(id, input)` — `{ name: z.string().trim().min(1).max(100), type: z.enum(PART_FIELD_TYPES), sort: z.number().int().min(0), active?: boolean }`
  - `deletePartFieldDef(id): Promise<void>` — 400 with blocker count while any live part holds a non-empty value
  - `partFieldDefBlockers(id): Promise<Blocker[]>` — reuses the `Blocker` type from `reference-blockers.ts`; each `{ entityLabel: "Part", name: "CODE · partNumber", id: partId, href: "/parts/<id>" }`, deduped per part
  - `listPartFieldValues(partId): Promise<{ fieldId; name; type; sort; active; value: string }[]>` — every **live** def (active or holding a value), joined with this part's values (`""` when unset)
  - `setPartFieldValues(partId, values: { fieldId: string; value: string }[]): Promise<void>`

- [ ] **Step 1: Failing tests** (one file, two describes)

```ts
// defs:
it("creates, lists by sort, partial-unique name among live rows")   // dup live name → "already exists"; delete-then-recreate → new id
it("delete with only empty values succeeds; non-empty value blocks")// blocked: rejects.toThrow("still holds a value on 1 part(s)")
it("partFieldDefBlockers names parts as CODE · partNumber with hrefs")
// values:
it("sets and lists values; clearing writes empty string")           // set "DWG-100", then "" → listPartFieldValues shows ""
it("NUMBER value must be a decimal string")                          // "abc" → rejects.toThrow('is not a valid number')
it("DATE value must be yyyy-mm-dd")                                  // "01/02/2026" → rejects.toThrow("is not a valid date")
it("CHECKBOX value must be true or false")                           // "maybe" → rejects.toThrow("must be true or false")
it("unknown or deleted fieldId is a 400 naming the field")           // rejects.toThrow("That field does not exist")
it("audit history reads as updates: before A → after B")             // partFieldValue update entry diff
it("unchanged value writes no audit entry")                          // set same value twice → exactly one create entry, zero updates
```

- [ ] **Step 2: Implement `part-field-defs.ts`**

CRUD follows `reference.ts`'s shape (findFirst-not-findUnique on `name`, audited-in-tx per Task 1, `withDbErrors` conflictField "name"). The guard:

```ts
export async function partFieldDefBlockers(id: string): Promise<Blocker[]> {
  const values = await prisma.partFieldValue.findMany({
    where: { fieldId: id, value: { not: "" }, part: { deletedAt: null } },
    include: { part: { select: { id: true, partNumber: true, customer: { select: { code: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  const seen = new Set<string>();
  const out: Blocker[] = [];
  for (const v of values) {
    if (seen.has(v.part.id)) continue;
    seen.add(v.part.id);
    out.push({ entityLabel: "Part", name: `${v.part.customer.code} · ${v.part.partNumber}`,
      id: v.part.id, href: `/parts/${v.part.id}` });
  }
  return out;
}

export async function deletePartFieldDef(id: string): Promise<void> {
  await withDbErrors({ entity: "Part field" }, () =>
    prisma.$transaction(async (tx) => {
      const blockers = await partFieldDefBlockersOn(tx, id);   // same query, parameterized on the client
      if (blockers.length) {
        throw new HttpError(400, `That field still holds a value on ${blockers.length} part(s)`);
      }
      await auditedSoftDelete("partFieldDef", id, undefined, tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
```

(Implement `partFieldDefBlockersOn(db, id)` once and have the public `partFieldDefBlockers` call it with `prisma` — the `findBlockers(kind, id, db)` precedent.)

- [ ] **Step 3: Implement `part-field-values.ts`**

Validation per type (values are canonical strings):

```ts
function validateValue(def: { name: string; type: string }, value: string): string {
  const v = value.trim();
  if (v === "") return "";
  switch (def.type) {
    case "NUMBER":
      if (!/^-?\d{1,12}(\.\d{1,6})?$/.test(v)) {
        throw new HttpError(400, `"${value}" is not a valid number for ${def.name}`);
      }
      return v;
    case "DATE":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
        throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${def.name}`);
      }
      return v;
    case "CHECKBOX":
      if (v !== "true" && v !== "false") {
        throw new HttpError(400, `${def.name} must be true or false`);
      }
      return v;
    default:
      if (v.length > 2000) throw new HttpError(400, `${def.name} is too long (2000 max)`);
      return v;
  }
}
```

`setPartFieldValues(partId, values)`: one **Serializable** transaction (it reads defs and writes values — the write-skew partner of `deletePartFieldDef`'s guard, exactly like the LOT/breaks pair) — assert part live; load the named defs (`findMany({ where: { id: { in: fieldIds }, deletedAt: null } })`, 400 `"That field does not exist"` on any miss); for each value: `findFirst` the existing row by `{ partId, fieldId }` (this unique is a **hard** unique — the model has no `deletedAt` — so `findUnique` is legal here, but use `findFirst` for uniformity); if none → `auditedCreate("partFieldValue", …)`; if changed → `auditedUpdate`; if identical → skip (no junk audit entries). Values on **inactive** defs remain settable — inactive hides from new entry, it does not invalidate (the §5.14 distinction); only a **deleted** def 400s.

- [ ] **Step 4: Gates, commit**

```bash
npx vitest run && npx tsc --noEmit && npx eslint src tests
git add -A && git commit -m "feat: part custom field definitions and values"
```

---

## Task 8: Parts routes — CRUD, children, `change_prices`, scoping

**Files:**
- Create: `erp/src/app/api/parts/route.ts`, `erp/src/app/api/parts/[id]/route.ts`, `erp/src/app/api/parts/[id]/specifications/route.ts`, `erp/src/app/api/parts/[id]/specifications/[linkId]/route.ts`, `erp/src/app/api/parts/[id]/inspections/route.ts`, `erp/src/app/api/parts/[id]/inspections/[inspId]/route.ts`, `erp/src/app/api/parts/[id]/breaks/route.ts`, `erp/src/app/api/parts/[id]/breaks/[breakId]/route.ts`, `erp/src/app/api/parts/[id]/fields/route.ts`
- Create: `erp/src/app/api/admin/part-fields/route.ts`, `erp/src/app/api/admin/part-fields/[id]/route.ts`, `erp/src/app/api/admin/part-fields/[id]/blockers/route.ts`, `erp/src/app/api/admin/part-fields/[id]/blockers/export/route.ts`
- Create: `erp/tests/parts-routes.test.ts`

**Interfaces:**
- Consumes: every service from Tasks 4–7; `gate`-relevant permission keys `parts.view/create/edit/delete`, `admin.view/create/edit/delete`, special `change_prices`; `canDo`/`mustDo` from `@/server/permissions`; `toXlsx` from `@/server/excel`.
- Produces: the route table from spec §8. Blocker export columns: `Type | Name | Link` (the 2C-1 shape).

- [ ] **Step 1: Failing route tests**

`erp/tests/parts-routes.test.ts` — use `signInWith(permissions)` from `tests/helpers/auth.ts`; every handler call passes ctx. Core cases (each a real `it`):

```ts
// auth sweep: for each route/method — 401 with no cookie, 403 with wrong-permission cookie,
// 200/201-shape with the right one. Follow tests/customers-routes tests' existing pattern.
it("GET /api/parts requires parts.view; POST requires parts.create")
it("POST with any pricing field present requires change_prices — even pricePer or a null")
    // body { …required, unitPrice: null } with parts.create only → 403
    // same body with parts.create + action.change_prices → 200
it("PATCH /api/parts/[id] pricing fields likewise; plain edits pass with parts.edit alone")
it("DELETE /api/parts/[id] requires parts.delete and passes reason from the body")
it("child routes 404 a child of a different part")
    // create part A's inspection, PATCH via part B's URL → 404
it("break routes demand change_prices unconditionally")
it("/api/admin/part-fields CRUD gates on admin area actions (create/edit/delete per method)")
it("blockers export returns an xlsx content-type and disposition")
```

- [ ] **Step 2: Implement the routes**

`/api/parts/route.ts`:

```ts
import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan, mustDo } from "@/server/permissions";
import { listParts, createPart } from "@/server/parts";
import { PRICING_FIELDS } from "@/lib/part-constants";

export const GET = handle(async (req) => {
  mustCan(requireUser(), "parts", "view");
  const url = new URL(req.url);
  return NextResponse.json(await listParts({
    includeInactive: url.searchParams.get("includeInactive") === "1",
    search: url.searchParams.get("search") ?? undefined,
  }));
});

export const POST = handle(async (req) => {
  const user = requireUser();
  mustCan(user, "parts", "create");
  const body = (await req.json()) as Record<string, unknown>;
  // Presence, not truthiness: setting a price to null is still a price change.
  if (PRICING_FIELDS.some((f) => f in body)) mustDo(user, "change_prices");
  return NextResponse.json(await createPart(body));
});
```

`/api/parts/[id]/route.ts` mirrors `/api/customers/[id]/route.ts` exactly (GET view / PATCH edit + conditional `mustDo` as above / DELETE delete with the reason-from-body shape, calling `deletePart`). Child routes all follow one shape — e.g. `/api/parts/[id]/inspections/[inspId]/route.ts`:

```ts
export const PATCH = handle(async (req, { params }) => {
  mustCan(requireUser(), "parts", "edit");
  const { id, inspId } = await params;
  await updatePartInspection(id, inspId, await req.json());
  return NextResponse.json({ ok: true });
});
```

(the service's `{ id: inspId, partId, deletedAt: null }` filter is what makes the URL scoping real). Break routes add `mustDo(user, "change_prices")` after the `mustCan`. `/api/parts/[id]/fields/route.ts`: GET → `listPartFieldValues`, PUT (parts.edit) → `setPartFieldValues(id, body.values)` with `z.object({ values: z.array(z.object({ fieldId: z.string(), value: z.string() })) }).strict()` parsed in the route. Admin part-fields routes copy the step-codes admin routes' gating (`admin` area, action per method); the blockers/export routes copy `api/admin/reference/[kind]/[id]/blockers{,/export}` with `partFieldDefBlockers` and `toXlsx("Blockers", [{ key: "entityLabel", header: "Type" }, { key: "name", header: "Name" }, { key: "href", header: "Link" }], …)`.

- [ ] **Step 3: Gates, commit**

The permissions sweep (`tests/permissions-sweep.test.ts`) walks route files — it should pass without edits; if it flags a new route, the route is missing its `requireUser`/`mustCan` first line, so fix the route.

```bash
npx vitest run && npx tsc --noEmit && npx eslint src tests && npm run build
git add -A && git commit -m "feat: parts and part-fields API routes"
```

---

## Task 9: Excel export and paste

**Files:**
- Modify: `erp/src/server/parts.ts` (add `pasteParts`)
- Create: `erp/src/app/api/parts/export/route.ts`, `erp/src/app/api/parts/paste/route.ts`
- Create: `erp/tests/parts-paste-export.test.ts`

**Interfaces:**
- Produces: `pasteParts(text: string, opts: { allowPricing: boolean }): Promise<PasteResult>` (the `PasteResult` from `@/server/paste`). Paste columns = `PART_PASTE_COLUMNS` (Task 4). Export columns (spec §8): Customer code, Customer name, Part number, Name, Description, Material, Each wt, Load qty, Load wt, Serialization, Setup, Unit price, Min charge, Price per, Active.

- [ ] **Step 1: Failing tests**

```ts
it("pastes rows resolving customer by code and material by name")     // 2 good rows → created 2; materialName "Ductile iron" resolved
it("unknown customer code and unknown material are per-row errors")   // errors[0].message contains 'Customer "ZZZ" does not exist'; material likewise
it("serialization accepts yes/no (case-insensitive), errors otherwise")
it("pricePer accepts the enum names case-insensitively")               // "lb" → LB; "per box" → per-row error naming valid values
it("pricing cells without allowPricing are per-row errors")            // "Requires change_prices"
it("one bad row does not discard the rest; blank rows skipped; row numbers are 1-based lines")
it("eachWeight ≤ 0 is a per-row error")
it("export writes names not cuids and includes Active")                // parse the buffer with exceljs, assert header row + a material name cell
it("paste route: parts.create required; pricing per-row honors the caller's change_prices")
```

- [ ] **Step 2: Implement `pasteParts`**

Follows `pasteCustomers` exactly (`parseRecords`/`isBlankRecord`/`overflowError`, per-row `readableMessage`, trailing structural error), with a per-row prelude before `createPart`:

```ts
const PRICING_PASTE_CELLS = ["setupCharge", "unitPrice", "minimumCharge", "pricePer"] as const;

function parseBool(cell: string, column: string): boolean {
  const v = cell.trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(v)) return true;
  if (["", "no", "n", "false", "0"].includes(v)) return false;
  throw new HttpError(400, `${column} must be Yes or No`);
}

function parsePricePer(cell: string): string {
  const v = cell.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if ((PRICE_PER as readonly string[]).includes(v)) return v;
  throw new HttpError(400, `Price per must be one of: ${PRICE_PER.join(", ")}`);
}
```

Per row: map cells to `PART_PASTE_COLUMNS`; if any `PRICING_PASTE_CELLS` cell is non-empty and `!opts.allowPricing` → row error `"Requires change_prices to paste pricing columns"`; resolve `customerCode` → `prisma.customer.findFirst({ where: { code, deletedAt: null } })` (error `Customer "${code}" does not exist`); resolve `materialName` (when non-empty) the same way against `material.name`; build the `createPart` input (drop empty optional cells, the customers precedent), `serializationRequired` via `parseBool`, `pricePer` via `parsePricePer`; `await createPart(input)`.

Routes: `paste/route.ts` gates `parts.create`, computes `allowPricing: canDo(user, "change_prices")`, returns the `PasteResult`. `export/route.ts` gates `parts.view`, reuses the customers export route's header/disposition shape with `toXlsx("Parts", columns, rows)` over `listParts(query)` — build `rows` by mapping `PartRow` fields to the column keys and `active`/`serializationRequired` to `"yes"/"no"`.

- [ ] **Step 3: Gates, commit**

```bash
npx vitest run && npx tsc --noEmit && npx eslint src tests
git add -A && git commit -m "feat: parts Excel export and spreadsheet paste"
```

---

## Task 10: Customer-side obligations — child-route scoping retrofit, "still has parts" guard

**Files:**
- Modify: `erp/src/server/customer-addresses.ts`, `erp/src/server/customer-contacts.ts` (scoped signatures), `erp/src/server/customers.ts` (`deleteCustomer` guard)
- Modify: `erp/src/app/api/customers/[id]/addresses/[addressId]/route.ts`, `erp/src/app/api/customers/[id]/contacts/[contactId]/route.ts`
- Create: `erp/tests/customer-child-scoping.test.ts`

**Interfaces:**
- Changes: `updateAddress(customerId, addressId, input)`, `deleteAddress(customerId, addressId)`, `updateContact(customerId, contactId, input)`, `deleteContact(customerId, contactId)` — each's live-row lookup becomes `findFirst({ where: { id, customerId, deletedAt: null } })` and each claim-live `updateMany` adds `customerId` to its WHERE. Routes pass `(await params).id` through.

- [ ] **Step 1: Failing tests**

```ts
it("an address of customer X is not editable through customer Y's URL")   // PUT via Y's URL → 404; row unchanged
it("nor deletable")                                                        // DELETE via Y's URL → 404; row still live
it("contacts: same two assertions")
it("deleteCustomer refuses while live parts exist")                        // rejects.toThrow("That customer still has parts")
it("deleteCustomer succeeds once its parts are deleted")                   // deletePart(with reason) first → customer delete OK
```

- [ ] **Step 2: Implement**

Service signature changes as above (TypeScript flags the route call sites; update them to pass both params). In `deleteCustomer`, after the child-customers guard:

```ts
const parts = await prisma.part.count({ where: { customerId: id, deletedAt: null } });
if (parts > 0) throw new HttpError(400, "That customer still has parts");
```

(A count, not a blocker list, by spec §11: the parts list filtered by the customer already names every part with links.)

- [ ] **Step 3: Gates, commit**

```bash
npx vitest run && npx tsc --noEmit && npx eslint src tests
git add -A && git commit -m "fix: scope customer child routes to their customer; block deleting customers with parts"
```

---

## Task 11: The stale-response gate and the parts list page

**Files:**
- Create: `erp/src/lib/use-latest.ts`, `erp/tests/use-latest.test.ts`
- Create: `erp/src/app/parts/page.tsx`
- Modify: `erp/src/app/customers/page.tsx` (adopt the gate — closes backlog #5 as a shared pattern)
- Modify: `erp/src/components/Shell.tsx` **only if** the Parts nav entry is missing (check first — Phase 1 built nav entries that 404 until their page exists).

**Interfaces:**
- Produces: `makeLatestGate(): { next(): number; isCurrent(t: number): boolean }` (pure, tested) and `useLatest()` (one gate per mount, via `useRef`).

- [ ] **Step 1: Failing gate test**

```ts
import { describe, it, expect } from "vitest";
import { makeLatestGate } from "@/lib/use-latest";

describe("makeLatestGate", () => {
  it("only the newest ticket is current", () => {
    const g = makeLatestGate();
    const a = g.next(); const b = g.next();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });
  it("a later ticket invalidates all earlier ones at issue time, not resolve time", () => {
    const g = makeLatestGate();
    const a = g.next();
    expect(g.isCurrent(a)).toBe(true);
    g.next();
    expect(g.isCurrent(a)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement `use-latest.ts`**

```ts
"use client";
// Client-safe: no src/server imports. Guards a fetch-into-state effect against out-of-order
// responses: a response is applied only if it belongs to the newest request (backlog #5 — a
// stale customer-list search response could overwrite a newer one; the parts list has the same
// shape, so the fix is this shared gate rather than two copies).
import { useRef } from "react";

export function makeLatestGate() {
  let seq = 0;
  return {
    next: () => ++seq,
    isCurrent: (ticket: number) => ticket === seq,
  };
}

export function useLatest() {
  const ref = useRef<ReturnType<typeof makeLatestGate> | null>(null);
  ref.current ??= makeLatestGate();
  return ref.current;
}
```

- [ ] **Step 3: The parts list page**

`erp/src/app/parts/page.tsx` — the customers list page's shape (read it first; same fetcher, same gating idiom), with: columns Customer (shown as `CODE · name`, plain text), Part number (**the linked cell**, to `/parts/{id}`), Name, Material, Each wt, Active; search box `placeholder="Search part number or customer"`; show-inactive checkbox; `Export to Excel` anchor to `/api/parts/export?…`; `Paste from spreadsheet` toggling a `<PasteGrid endpoint="/api/parts/paste" columns={[...PART_PASTE_COLUMNS]} onDone={load} />`; an add row with the required trio — a customer `<select>` (fed by `/api/customers`, fetched only when `customersGate.allowed`; when `gate(perms, "customers.view").disabled`, render the select disabled with its title), a part-number input, an each-weight input — and an Add button gated `parts.create`. The load function threads the gate:

```ts
const gate = useLatest();
const load = useCallback(async () => {
  const t = gate.next();
  const data = await api<PartRow[]>(`/api/parts${query ? `?${query}` : ""}`);
  if (!gate.isCurrent(t)) return;
  setRows(data);
}, [query, gate]);
useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
```

Row type on the page mirrors `PartRow`'s listed columns (id, partNumber, name, customerCode, customerName, materialName, eachWeight, active) — declare it locally like the customers page does; **do not import from `src/server/parts.ts`**.

- [ ] **Step 4: Customers page adopts the gate**

In `src/app/customers/page.tsx`, add `const gate = useLatest();` and wrap its `load` body with the ticket check exactly as above.

- [ ] **Step 5: Build + gates, verify nav, commit**

Run `npm run dev` briefly if needed to confirm `/parts` renders and the nav highlights it; then:

```bash
npx vitest run && npx tsc --noEmit && npx eslint src tests && npm run build
git add -A && git commit -m "feat: parts list page with shared stale-response gate"
```

---

## Task 12: The part detail page

**Files:**
- Create: `erp/src/app/parts/[id]/page.tsx`, plus in the same directory: `IdentitySection.tsx`, `SpecsSection.tsx`, `InspectionsSection.tsx`, `PricingSection.tsx`, `CustomFieldsSection.tsx`

**Interfaces:**
- Consumes: every `/api/parts/[id]*` route; `/api/picklists/{material,specification,inspectionCode,inspectionScale}`; `usePermissions` + `gate`/`gateDo`; `HistoryPanel({ entity: "part", entityId: id })`; `PRICE_PER_LABELS`.

Read `src/app/customers/[id]/page.tsx` before writing anything — it is the styling, error-banner, and save-flow precedent (including rule §5.13: roll back to server truth first, then report the error; never reload after setting the banner).

- [ ] **Step 1: `page.tsx` — the frame**

A client component that: reads `id` from `useParams()`; fetches `/api/parts/${id}` into `part`; renders the sections **keyed by id** (`<PartDetail key={id} …>` — handoff §5.12: `defaultValue`-bound fields otherwise keep the previous record's text); holds one error banner all sections report into; passes `perms` down once from `usePermissions()`. Section order: Identity, Specifications, Inspections, Pricing, Custom fields, `<HistoryPanel entity="part" entityId={id} />`, then the Delete control (prompt for a reason exactly like the customer page's delete; gated `gate(perms, "parts.delete")`).

- [ ] **Step 2: `IdentitySection.tsx`**

Customer shown read-only as `CODE · name` linked to `/customers/{customerId}` (never an input — customerId is immutable). Editable: part number, name, description, material (a `<select>` over `/api/picklists/material?includeInactive=1` — options labeled `“(inactive)”` when inactive, **no `.catch(() => {})`**: a fetch failure sets the page error banner), each-weight, load qty, load wt, serialization checkbox, active checkbox. Save PATCHes `/api/parts/${id}` with only the identity fields; inputs render `readOnly`/`disabled` when `gate(perms, "parts.edit").disabled`, with the gate's `title`.

- [ ] **Step 3: `SpecsSection.tsx`**

Chips of `listPartSpecs` results (`specificationName` + an × button gated `parts.edit`); an add `<select>` over `/api/picklists/specification` + Add button POSTing `{ specificationId }` to `/api/parts/${id}/specifications`; remove DELETEs `/api/parts/${id}/specifications/${linkId}`.

- [ ] **Step 4: `InspectionsSection.tsx`**

A grid of rows (code select from `/api/picklists/inspectionCode`, scale select from `/api/picklists/inspectionScale` **pre-filled from nothing here** — the code's default scale lives server-side on the reference row, so on code selection fetch nothing extra: instead include the default in the picklist? **No.** Keep it simple and honest: when the user picks a code and the scale is still blank, the section fetches `/api/admin/reference/...`? — that route is admin-gated. **Resolution:** the pick-list projection is `{ id, name, active }` only, so the default-scale prefill is *not available* to a non-admin screen; leave the scale blank for the user to choose, and note it as a recorded papercut in the PR body rather than widening any route. min, max, location inputs; sort via up/down buttons that renumber and PATCH). Add POSTs to `/api/parts/${id}/inspections`; edits PATCH per row on blur/Save; delete per row. All controls gated `parts.edit`.

- [ ] **Step 5: `PricingSection.tsx`**

Inputs for setup/unit/minimum (text inputs, right-aligned), price-per `<select>` over `PRICE_PER_LABELS`, and the breaks grid (threshold, price, add/edit/delete). **Every control** in this section uses `const priceGate = gateDo(perms, "change_prices")` combined with the edit gate — disabled with `priceGate.title` ("Requires change_prices") when missing. Saving pricing PATCHes only pricing fields (so a user without `change_prices` editing the name never trips the route's pricing check). The LOT+breaks 400 from the service surfaces in the section's error line verbatim.

- [ ] **Step 6: `CustomFieldsSection.tsx`**

Fetch `/api/parts/${id}/fields`; render each row by `type` — TEXT `<input>`, NUMBER `<input inputMode="decimal">`, DATE `<input type="date">`, CHECKBOX `<input type="checkbox">` (checked ⇔ value `"true"`); Save PUTs `{ values: [{ fieldId, value }] }` for **changed rows only**. Inactive defs render only when they hold a non-empty value, labeled "(inactive)".

- [ ] **Step 7: Build, lint, manual smoke, commit**

```bash
npx vitest run && npx tsc --noEmit && npx eslint src tests && npm run build
```

Manual smoke against `npm run dev` (admin/admin): create a part from the list page, open it, add a spec, an inspection row, a price break, set a custom field, delete the part with a reason — each action lands in the History panel. Clean the fixtures out of the **dev** database afterwards (`erp`, not `erp_test`).

```bash
git add -A && git commit -m "feat: part detail page"
```

---

## Task 13: Part-fields admin page

**Files:**
- Create: `erp/src/app/admin/part-fields/page.tsx`
- Modify: `erp/src/components/Shell.tsx` — add "Part fields" to the admin nav group (match how "Step codes" is registered; gate on the same admin visibility rule the other admin entries use).

**Interfaces:** consumes `/api/admin/part-fields*` (Task 8).

- [ ] **Step 1: The page**

Model it on the step-codes admin page's grid (read it first): rows of name / type select / sort / active toggle; Add row; Delete per row. On a 400 from DELETE, fetch `/api/admin/part-fields/${id}/blockers` and render the blocker panel exactly as `ReferenceTable.tsx` does (linked rows + an "Export blockers" anchor to `.../blockers/export`) — reuse its markup shape, or extract its blocker panel into a small shared component if that is cleaner than copying (implementer's call; copying twice is the ceiling before extraction becomes mandatory).

- [ ] **Step 2: Gates, commit**

```bash
npx vitest run && npx tsc --noEmit && npx eslint src tests && npm run build
git add -A && git commit -m "feat: part custom-field admin page"
```

---

## Task 14: Close-out — full verification and the owner demo script

- [ ] **Step 1: Clean-room verification**

```bash
npx prisma migrate deploy                    # dev DB: "No pending migrations"
DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy
npx vitest run                               # expect ≥ 380 passing, 0 skipped
npx tsc --noEmit && npx eslint src tests && npm run build
```

- [ ] **Step 2: Sweep-bite audit**

Confirm by reading (not rerunning history): the reference-links sweep's known-FK list holds 8 entries; the partial-unique sweep's schema walk sees all four new partial uniques (grep the schema for `@@unique` and count); `tests/permissions-sweep.test.ts` covers every new route file.

- [ ] **Step 3: Post the demo script for the owner (in the session, not a file)**

Walk: Admin → Part fields → add "Customer drawing number" (TEXT) and "Revision level" (TEXT) → Parts → paste five real parts with prices from Excel → open one → material, two specs, two inspection rows (same code, two locations), three price breaks → try deleting the material under it (blocked, named, exportable) → deactivate vs delete distinction → History panel showing every step.

- [ ] **Step 4: Commit any stragglers; the branch is ready for its final whole-branch review**

Merge itself is out of scope here — superpowers:finishing-a-development-branch takes over after the final review verdict.

---

## Plan Self-Review (performed at write time)

**Spec coverage:** §3 rulings → Tasks 4/6 (break basis is untyped storage + LOT rule; material optional `materialId String?`; 4-decimal `unitPrice`/`price`); §4 models → Task 3; §5.1 → Task 1; §5.2 → Task 2; §6 registry → Task 3; §7 services/guards → Tasks 4–7, 10; §8 routes → Tasks 8–9; §9 UI → Tasks 11–13; §10 testing → distributed per task, sweeps in 3/8/14. The export→paste round-trip contract stays out (spec §2, backlog). Pagination stays out. Attachments/quotes stay out.

**Known intentional deviations from earlier drafts:** the inspection scale prefill-from-code's-default is *dropped* (Task 12 Step 4) because the pick-list projection deliberately excludes `defaultScaleId` — record it in the PR body as a papercut rather than widening a route this branch has no mandate to widen.

**Type consistency spot-checks:** `assertRefExists(kind, id, tx)` used with `("material" | "specification" | "inspectionCode" | "inspectionScale" | "terms" | "glAccount", string, tx)` — all `ReferenceKind` members ✓; `auditedSoftDelete(model, id, reason, tx)` positional `tx` everywhere ✓; `PartRow.pricePer: PricePerValue` matches `z.enum(PRICE_PER)` ✓; `Blocker` reused from `reference-blockers.ts` in Task 7 ✓; `PART_PASTE_COLUMNS` declared once (Task 4) and consumed by Tasks 9/11 ✓.
