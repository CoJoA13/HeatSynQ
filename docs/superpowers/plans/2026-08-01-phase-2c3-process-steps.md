# Phase 2C-3 — Process Steps + Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parts own immutable-once-locked revisioned Process Steps; Templates load blank structure; step codes get §5.14 deletion protection via a generalized registry.

**Architecture:** Five new tables (revision → step → value; template → template step). All recipe mutations funnel through one service that enforces the revision-cut rule (amend unlocked, cut N+1 when locked) inside a single transaction. The blocker registry's target axis widens from `ReferenceKind` to `BlockerTarget` with a `liveWhere` override, keeping `findBlockers` branch-free. Spec: `docs/superpowers/specs/2026-08-01-phase-2c3-process-steps-design.md` (all § references below without a "HANDOFF" prefix are to it).

**Tech Stack:** Next.js 15 / React 19 client pages against guarded APIs, Prisma 7 (+pg adapter), zod 4, vitest against real `erp_test`, Playwright (bundled Chromium) for E2E.

## Global Constraints

- All commands run from `erp/`. Quality gates after every task: `npm test`, `npx tsc --noEmit`, `npx eslint src tests` (plus `npm run build` before review rounds).
- TDD per task: failing test → implement → pass → commit. Conventional commits, **no attribution trailers** (owner instruction).
- Every mutation through `auditedCreate`/`auditedUpdate`/`auditedSoftDelete` — `tx` is REQUIRED (`opts: { tx }`). Canonical nesting: `withDbErrors` → `prisma.$transaction` → `audited*` → writes on `tx`.
- Any write assigning a non-null registered-FK column runs its transaction **Serializable** and calls `assertRefExists(target, id, tx)` inside it.
- Never `findUnique`/`upsert`/`update`/`delete` keyed on a partial-unique column (`ProcessTemplate.name`); use `findFirst({ where: { name, deletedAt: null } })`. Partial `@@unique(...)` attributes stay on ONE line.
- `npx prisma migrate dev` refuses without a TTY. Migration recipe: `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script`, read the output IN FULL, hand-write it into `prisma/migrations/<timestamp>_<name>/migration.sql`, then `npx prisma migrate deploy` AND `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy`, then `npx prisma generate`.
- Client components never import from `src/server/**`; shared constants/types go in `src/lib/`.
- Route handlers: `handle(async (req, { params }) => …)`; first line `mustCan(requireUser(), area, action)` (`requireUser()` is sync, no argument). Route tests pass ctx: `handler(request, { params: Promise.resolve({ id }) })`.
- Expected failures are `HttpError(400|403|404, message)`, field-anchored messages.
- Tests share one DB: `truncateAll()` in `beforeEach` (import from `tests/helpers/db`), `signInWith(permissions)` from `tests/helpers/auth` for route tests. Do not parallelize.
- Owner rulings binding this plan (spec §3): Load Template = replace-with-confirm; step-code delete blocked on ANY live use; renames propagate (no denormalized display columns); guard = generalized registry; E2E UI coverage is a deliverable.

---

### Task 1: Schema — five tables + migration to both DBs

**Files:**
- Modify: `prisma/schema.prisma` (after the `PartFieldValue` model; plus back-relations on `Part`, `ProcessStepCode`, `ProcessStepFieldDef`)
- Create: `prisma/migrations/<timestamp>_process_steps_and_templates/migration.sql`
- Test: `tests/process-schema.test.ts`

**Interfaces:**
- Consumes: existing models `Part`, `ProcessStepCode`, `ProcessStepFieldDef`, enum `StepFieldType`.
- Produces: models `PartProcessRevision`, `PartProcessStep`, `PartProcessStepValue`, `ProcessTemplate`, `ProcessTemplateStep` exactly as spec §4 (copy the prisma blocks from the spec verbatim — they are the contract). Back-relations: `Part.processRevisions PartProcessRevision[]`, `ProcessStepCode.partSteps PartProcessStep[]`, `ProcessStepCode.templateSteps ProcessTemplateStep[]`, `ProcessStepFieldDef.values PartProcessStepValue[]`.

- [ ] **Step 1: Edit `prisma/schema.prisma`** — add the five models from spec §4 verbatim (no `onDelete` anywhere in the new chain; `ProcessTemplate`'s partial unique on ONE line: `@@unique([name], where: raw("\"deletedAt\" IS NULL"))`), plus the four back-relations.
- [ ] **Step 2: Produce the migration** per the Global Constraints TTY recipe. Read the full generated SQL; verify it is purely additive (5 `CREATE TABLE`, FK constraints, the listed `@@unique`/`@@index` indexes, and a partial unique index `ON "ProcessTemplate"("name") WHERE "deletedAt" IS NULL`). Hand-write it into the migration directory.
- [ ] **Step 3: Apply to BOTH databases and regenerate** (three commands from the recipe). Expected: both `migrate deploy` runs report the new migration applied; `npx tsc --noEmit` clean.
- [ ] **Step 4: Write the smoke test** `tests/process-schema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";

describe("process steps schema", () => {
  beforeEach(truncateAll);

  it("stores a revision -> step -> value graph and a template -> step graph", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1" } });
    const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
    const def = await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    const step = await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "per spec" },
    });
    await prisma.partProcessStepValue.create({ data: { stepId: step.id, fieldDefId: def.id, value: "1650" } });
    const tpl = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplateStep.create({
      data: { templateId: tpl.id, position: 1, codeId: code.id, boilerplate: "load per racking sheet" },
    });

    const back = await prisma.partProcessRevision.findFirst({
      where: { partId: part.id }, include: { steps: { include: { values: true } } },
    });
    expect(back?.steps[0]?.values[0]?.value).toBe("1650");
  });

  it("ProcessTemplate.name is unique only among live rows", async () => {
    const t1 = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplate.update({ where: { id: t1.id }, data: { deletedAt: new Date() } });
    const t2 = await prisma.processTemplate.create({ data: { name: "Austemper" } }); // must not throw
    expect(t2.id).not.toBe(t1.id);
    await expect(prisma.processTemplate.create({ data: { name: "Austemper" } })).rejects.toThrow();
  });
});
```

Note: if `truncateAll` enumerates tables explicitly rather than querying the catalog, add the five new tables to it in this step.
- [ ] **Step 5: Run** `npx vitest run tests/process-schema.test.ts` → PASS; run `npx vitest run tests/partial-unique-sweep.test.ts` → PASS (it must pick up `ProcessTemplate` automatically; if it fails on a bare `@unique`, the schema is wrong, not the sweep).
- [ ] **Step 6: Full gates, then commit** `feat: add process revision, step, value, and template models`

---

### Task 2: Registry generalization — `BlockerTarget` + `liveWhere`

**Files:**
- Modify: `src/lib/reference-links.ts`, `src/server/reference-blockers.ts`, `src/server/reference-guards.ts`, `tests/reference-links-sweep.test.ts`
- Test: `tests/process-step-code-blockers.test.ts`

**Interfaces:**
- Consumes: Task 1's models; existing `findBlockers(kind, id, db)`, `assertRefExists(kind, id, tx)`, `partLabel`.
- Produces (later tasks call these EXACT names):
  - `export type BlockerTarget = ReferenceKind | "processStepCode"` (in `src/lib/reference-links.ts`)
  - `export const TARGET_LABELS: Record<"processStepCode", string>` — value `"process step code"` (only the non-reference targets live here; reference kinds keep using `REFERENCE_LABELS`)
  - `ReferenceLink.targetKind: BlockerTarget`; new optional `liveWhere?: Record<string, unknown>`
  - `findBlockers(target: BlockerTarget, id: string, db?)` and `linksTargeting(target: BlockerTarget)`
  - `assertRefExists(target: BlockerTarget, id: string, tx)` — unchanged behavior for reference kinds

- [ ] **Step 1: Write failing tests** `tests/process-step-code-blockers.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { findBlockers } from "@/server/reference-blockers";
import { assertRefExists } from "@/server/reference-guards";
import { HttpError } from "@/server/errors";

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1" } });
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  return { customer, part, code };
}
const step = (revisionId: string, codeId: string, position = 1) =>
  prisma.partProcessStep.create({ data: { revisionId, codeId, position, instruction: "" } });

describe("findBlockers targeting processStepCode", () => {
  beforeEach(truncateAll);

  it("lists a part once even when two revisions use the code, and a template by name", async () => {
    const { part, code } = await fixture();
    const r1 = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1, lockedAt: new Date() } });
    const r2 = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 2 } });
    await step(r1.id, code.id); await step(r2.id, code.id);
    const tpl = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplateStep.create({ data: { templateId: tpl.id, position: 1, codeId: code.id } });

    const blockers = await findBlockers("processStepCode", code.id);
    expect(blockers).toHaveLength(2);
    const labels = blockers.map((b) => `${b.entityLabel}:${b.name}`).sort();
    expect(labels).toEqual(["Part:AC · P-1", "Template:Austemper"]);
    expect(blockers.find((b) => b.entityLabel === "Part")?.href).toBe(`/parts/${part.id}`);
    expect(blockers.find((b) => b.entityLabel === "Template")?.href).toBe(`/processes/templates/${tpl.id}`);
  });

  it("liveWhere: steps under a soft-deleted part or template do not block", async () => {
    const { part, code } = await fixture();
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await step(rev.id, code.id);
    const tpl = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplateStep.create({ data: { templateId: tpl.id, position: 1, codeId: code.id } });
    await prisma.part.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
    await prisma.processTemplate.update({ where: { id: tpl.id }, data: { deletedAt: new Date() } });
    expect(await findBlockers("processStepCode", code.id)).toHaveLength(0);
  });

  it("assertRefExists accepts a live (even inactive) code and 400s a soft-deleted one", async () => {
    const { code } = await fixture();
    await prisma.processStepCode.update({ where: { id: code.id }, data: { active: false } });
    await prisma.$transaction(async (tx) => { await assertRefExists("processStepCode", code.id, tx); });
    await prisma.processStepCode.update({ where: { id: code.id }, data: { deletedAt: new Date() } });
    await expect(
      prisma.$transaction(async (tx) => { await assertRefExists("processStepCode", code.id, tx); }),
    ).rejects.toThrow(HttpError);
  });
});
```

- [ ] **Step 2: Run → FAIL** (type error: `"processStepCode"` not assignable to `ReferenceKind`).
- [ ] **Step 3: Implement.** In `src/lib/reference-links.ts`:

```ts
export type BlockerTarget = ReferenceKind | "processStepCode";
export const TARGET_LABELS: Record<"processStepCode", string> = { processStepCode: "process step code" };
```

Widen `ReferenceLinkModel` with `"partProcessStep" | "processTemplateStep"`, change `targetKind: BlockerTarget`, add `liveWhere?: Record<string, unknown>` (doc comment: "Filter selecting the LIVE blocker rows. Defaults to `{ deletedAt: null }`; models whose liveness is inherited from a parent override it."), change `linksTargeting(target: BlockerTarget)`. Append two entries:

```ts
{ model: "partProcessStep", column: "codeId", targetKind: "processStepCode",
  label: "Step code", entityLabel: "Part", detailPath: (id) => `/parts/${id}`,
  liveWhere: { revision: { is: { part: { is: { deletedAt: null } } } } },
  include: { revision: { select: { part: { select: { id: true, partNumber: true, customer: { select: { code: true } } } } } } },
  blockerId: (r) => String(((r.revision as { part: { id: string } }).part).id),
  displayName: (r) => partLabel((r.revision as { part: unknown }).part) },
{ model: "processTemplateStep", column: "codeId", targetKind: "processStepCode",
  label: "Step code", entityLabel: "Template", detailPath: (id) => `/processes/templates/${id}`,
  liveWhere: { template: { is: { deletedAt: null } } },
  include: { template: { select: { id: true, name: true } } },
  blockerId: (r) => String((r.template as { id: string }).id),
  displayName: (r) => String((r.template as { name: string }).name) },
```

In `src/server/reference-blockers.ts`: signature `findBlockers(target: BlockerTarget, id, db)`; the query's where becomes `{ [link.column]: id, ...(link.liveWhere ?? { deletedAt: null }) }` — no other change; no model branches. In `src/server/reference-guards.ts`: parameter type `BlockerTarget`; label = `kind in TARGET_LABELS ? TARGET_LABELS[kind] : REFERENCE_LABELS[kind].singular.toLowerCase()` — resolved from data, not a model branch (use an `isReferenceKind` check via `REFERENCE_KINDS.includes`, not a hardcoded model name test).
- [ ] **Step 4: Extend the links sweep.** In `tests/reference-links-sweep.test.ts`, `schemaLinks` builds `const kinds = new Set<string>(REFERENCE_KINDS)` — add `kinds.add("processStepCode")` (with a comment naming `BlockerTarget` as the source of truth) so an unregistered schema FK targeting `ProcessStepCode` fails the sweep. Verify: temporarily comment out one new registry entry → sweep FAILS; restore → PASSES.
- [ ] **Step 5: Run new tests + full gates → PASS. Commit** `feat: generalize blocker registry to BlockerTarget with liveWhere`

---

### Task 3: Step-code field defs — `.strict()`, id-preserving edits, value blockers

**Files:**
- Modify: `src/server/process-step-codes.ts`
- Test: `tests/process-step-codes.test.ts` (extend existing file)

**Interfaces:**
- Consumes: Task 1 models; `Blocker` type from `src/server/reference-blockers`.
- Produces:
  - `FIELD` zod schema gains `.strict()` and an optional `id: z.string().optional()` per item.
  - `setStepFields(codeId, fields)` becomes **id-preserving**: items with `id` update that def; items without create; existing defs absent from the payload are deleted. Delete and type-change are refused with `HttpError(400, ...)` while any `PartProcessStepValue` references the def.
  - `export async function stepFieldBlockers(fieldDefId: string): Promise<Blocker[]>` — live parts (deduped, `CODE · partNumber`, href `/parts/[id]`) holding values for this def.

- [ ] **Step 1: Write failing tests** (append to `tests/process-step-codes.test.ts`; reuse its existing setup idiom):

```ts
// .strict(): an unknown key on a field item 400s instead of being dropped
await expect(setStepFields(code.id, [{ label: "Temp", type: "NUMBER", sort: 1, bogus: "x" } as never]))
  .rejects.toMatchObject({ status: 400 });

// id-preserving: relabeling keeps the def id, so values survive
// (create def via setStepFields, attach a value row via raw prisma using Task 1 models,
//  then setStepFields again with the SAME id and a new label; assert the value row still
//  points at that id and the label changed)

// type-change blocked while a value exists: expect 400 whose message names the field label
// delete blocked while a value exists: payload omitting that def -> 400
// label/unit edits allowed while values exist
// stepFieldBlockers lists the part once across two revisions' values
```

Write these as five real `it(...)` blocks with the fixture pattern from Task 2 (customer → part → revision → step → value).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** in `src/server/process-step-codes.ts`: add `.strict()` and optional `id`; rewrite `setStepFields` to diff by id inside its existing transaction: for each existing def, if absent from payload → check `tx.partProcessStepValue.count({ where: { fieldDefId } })`, refuse with `` `Cannot remove field "${def.label}" — ${n} step value(s) use it` `` when n > 0, else `tx.processStepFieldDef.delete`; if present with changed `type` → same count check, refuse `` `Cannot change the type of "${def.label}" — ${n} step value(s) use it` ``; else update in place. New items create. Keep the wholesale wrapping (`auditedUpdate` on the code) exactly as the current implementation does. `stepFieldBlockers` queries `partProcessStepValue` where `fieldDefId`, `step: { revision: { part: { deletedAt: null } } }`, includes the part + customer code, dedupes by part id, maps to `Blocker` rows.
- [ ] **Step 4: Run tests + gates → PASS. Commit** `feat: id-preserving step field edits with value blockers and .strict()`

---

### Task 4: Revisions + steps service (the revision-cut rule)

**Files:**
- Create: `src/server/part-process-steps.ts`
- Modify: `src/server/audit.ts` (extend `AuditableModel` union + `SNAPSHOT_INCLUDE`)
- Test: `tests/part-process-steps.test.ts`

**Interfaces:**
- Consumes: `assertRefExists("processStepCode", codeId, tx)` (Task 2); audited helpers; `withDbErrors`; `HttpError`.
- Produces (Tasks 6–10 and Phase 3 rely on these EXACT signatures):

```ts
export type RevisionSummary = { revisionNumber: number; lockedAt: Date | null; stepCount: number; createdAt: Date };
export type StepValueRow = { fieldDefId: string; label: string; type: string; unit: string | null; sort: number; value: string };
export type StepRow = { id: string; position: number; codeId: string; code: string; codeName: string; instruction: string; values: StepValueRow[] };
export type RevisionDetail = { revisionNumber: number; lockedAt: Date | null; steps: StepRow[] };
export async function getRevisions(partId: string): Promise<RevisionSummary[]>            // newest first; 404 if part missing/deleted
export async function getRevision(partId: string, revisionNumber: number): Promise<RevisionDetail>
export async function addStep(partId: string, input: { codeId: string; instruction?: string; values?: { fieldDefId: string; value: string }[] }): Promise<{ revisionNumber: number; stepId: string }>
export async function updateStep(partId: string, stepId: string, input: { instruction?: string; values?: { fieldDefId: string; value: string }[] }): Promise<{ revisionNumber: number }>
export async function removeStep(partId: string, stepId: string): Promise<{ revisionNumber: number }>
export async function reorderSteps(partId: string, orderedStepIds: string[]): Promise<{ revisionNumber: number }>
export async function lockRevision(partId: string, revisionNumber: number, tx: Prisma.TransactionClient): Promise<void>
```

Audit: `AuditableModel` gains `"partProcessRevision"`; `SNAPSHOT_INCLUDE.partProcessRevision = { steps: { orderBy: { position: "asc" }, include: { code: { select: { code: true, name: true } }, values: { include: { fieldDef: { select: { label: true } } } } } } }`.

- [ ] **Step 1: Write the failing tests** — one `it` per spec §5 behavior plus typing and audit content. Fixture: customer → part → step code `HT-01` with a NUMBER def `Temperature` (via raw prisma). The load-bearing cases, written out in full in the test file:

```ts
it("first mutation lazily creates revision 1", ...);           // getRevisions -> [] before; addStep -> rev 1
it("amend-in-place: edits before a lock keep the revision id and number", ...);
it("post-lock edit cuts N+1 copying steps and values, then applies the change", async () => {
  // addStep with instruction "A" + value 1650; lockRevision(part.id, 1, tx) via prisma.$transaction
  // updateStep(part, stepId, { instruction: "B" })
  // expect revisionNumber 2; rev 2 has one step, instruction "B", value "1650" (copied)
  // rev 1 re-read: instruction still "A", value still "1650", same step id as before
});
it("a locked revision's content is byte-identical after post-lock edits", ...);  // deep-compare getRevision(part,1) before/after
it("lockRevision is idempotent and 404s on a missing revision", ...);
it("a stepId from a superseded revision 404s", ...);           // cut to rev 2, then updateStep with the REV-1 step id
it("values are typed per StepFieldType with field-anchored messages", ...);      // NUMBER rejects "hot"; DATE rejects 2025-02-29; CHECKBOX rejects "yes"; empty string deletes the value row
it("addStep 400s on a soft-deleted code and accepts an inactive one", ...);
it("reorder is atomic and keeps positions 1..n", ...);
it("removeStep closes the position gap", ...);
it("audit: a step edit writes a revision-level update whose after-snapshot shows the change", async () => {
  // readAudit("partProcessRevision", revId) — newest entry's after JSON contains the new instruction
});
```

- [ ] **Step 2: Run → FAIL** (module not found).
- [ ] **Step 3: Implement `src/server/part-process-steps.ts`.** Core shape:

```ts
const VALUE_ITEM = z.object({ fieldDefId: z.string().min(1), value: z.string().max(500) }).strict();
const ADD = z.object({ codeId: z.string().min(1), instruction: z.string().max(4000).default(""), values: z.array(VALUE_ITEM).default([]) }).strict();
const EDIT = z.object({ instruction: z.string().max(4000).optional(), values: z.array(VALUE_ITEM).optional() }).strict();

/** Mirror of part-field-values' validateValue, against StepFieldType (same four cases; TEXT max 500). */
function validateStepValue(def: { label: string; type: string }, value: string): string { /* copy the NUMBER/DATE/CHECKBOX/TEXT logic from src/server/part-field-values.ts:validateValue, message-anchored on def.label */ }

/** THE revision-cut rule (spec §5). Returns the working revision and, when a cut happened,
 *  a position-keyed map from the locked revision's step ids to their copies. */
async function workingRevision(partId: string, tx: Prisma.TransactionClient):
  Promise<{ rev: { id: string; revisionNumber: number }; stepIdMap: Map<string, string> | null }> {
  const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
  if (!part) throw new HttpError(404, "Part not found");
  const current = await tx.partProcessRevision.findFirst({
    where: { partId }, orderBy: { revisionNumber: "desc" },
    include: { steps: { orderBy: { position: "asc" }, include: { values: true } } },
  });
  if (!current) {
    const rev = await auditedCreate("partProcessRevision", { partId, revisionNumber: 1 },
      () => tx.partProcessRevision.create({ data: { partId, revisionNumber: 1 } }), { tx });
    return { rev, stepIdMap: null };
  }
  if (!current.lockedAt) return { rev: current, stepIdMap: null };
  // locked current -> cut N+1: copy every step and value (spec §5.4 — own-part continuity, NOT copy-from-another-part)
  const next = await auditedCreate("partProcessRevision", { partId, revisionNumber: current.revisionNumber + 1 },
    () => tx.partProcessRevision.create({ data: { partId, revisionNumber: current.revisionNumber + 1 } }), { tx });
  const stepIdMap = new Map<string, string>();
  for (const s of current.steps) {
    const copy = await tx.partProcessStep.create({ data: {
      revisionId: next.id, position: s.position, codeId: s.codeId, instruction: s.instruction,
      values: { create: s.values.map((v) => ({ fieldDefId: v.fieldDefId, value: v.value })) },
    } });
    stepIdMap.set(s.id, copy.id);
  }
  return { rev: next, stepIdMap };
}
```

Each mutation: `withDbErrors({ entity: "Process step" }, () => prisma.$transaction(async (tx) => { const { rev, stepIdMap } = await workingRevision(partId, tx); … writes …; }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }))` — Serializable on `addStep` and `loadTemplate` (they assign `codeId`, a registered FK — `assertRefExists("processStepCode", codeId, tx)` first) and, for uniformity of the cut, on all step mutations. Wrap the writes of each mutation in ONE `auditedUpdate("partProcessRevision", rev.id, …, { tx })` so the before/after snapshots carry the step diff. `updateStep`/`removeStep` resolve `stepId` through `stepIdMap` when a cut happened; a stepId matching no step of the working revision → `HttpError(404, "That step belongs to a superseded revision")`. Values: parse, load defs `tx.processStepFieldDef.findMany({ where: { id: { in: … }, codeId: step.codeId } })` (a def from another code → 400 `"That field does not belong to this step's code"`), `validateStepValue`, empty string deletes the row, else create/update (skip identical). `reorderSteps`: verify the id set equals the working revision's live step ids, two-phase update (first pass position = -(index+1), second pass position = index+1). `removeStep`: delete values then the step, then close the gap (`updateMany` decrement positions greater than the removed one — do it via per-row updates in position order to respect the unique index). `lockRevision`: `updateMany({ where: { partId, revisionNumber, lockedAt: null }, data: { lockedAt: new Date() } })`; if count 0, check existence — missing → 404, already locked → return (idempotent); write the audit entry (auditedUpdate) only when it actually locked.
- [ ] **Step 4: Register audit** — extend `AuditableModel` and `SNAPSHOT_INCLUDE` in `src/server/audit.ts` per the Interfaces block.
- [ ] **Step 5: Run tests + full gates → PASS. Commit** `feat: part process steps service with revision-cut rule`

---

### Task 5: Templates service

**Files:**
- Create: `src/server/process-templates.ts`
- Modify: `src/server/audit.ts` (`"processTemplate"` + `SNAPSHOT_INCLUDE.processTemplate = { steps: { orderBy: { position: "asc" }, include: { code: { select: { code: true, name: true } } } } }`)
- Test: `tests/process-templates.test.ts`

**Interfaces:**
- Consumes: audited helpers, `assertRefExists("processStepCode", …)`, `withDbErrors`, `HttpError`.
- Produces:

```ts
export type TemplateSummary = { id: string; name: string; active: boolean; stepCount: number; updatedAt: Date };
export type TemplateStepRow = { id: string; position: number; codeId: string; code: string; codeName: string; boilerplate: string };
export type TemplateDetail = { id: string; name: string; active: boolean; steps: TemplateStepRow[] };
export async function listTemplates(opts?: { includeInactive?: boolean }): Promise<TemplateSummary[]>
export async function getTemplate(id: string): Promise<TemplateDetail>                       // 404 when missing/deleted
export async function createTemplate(input: { name: string }): Promise<{ id: string }>
export async function updateTemplate(id: string, input: { name?: string; active?: boolean }): Promise<void>
export async function deleteTemplate(id: string, reason: string): Promise<void>              // reason required, trimmed, service-enforced
export async function addTemplateStep(templateId: string, input: { codeId: string; boilerplate?: string }): Promise<{ id: string }>
export async function updateTemplateStep(templateId: string, stepId: string, input: { boilerplate: string }): Promise<void>
export async function removeTemplateStep(templateId: string, stepId: string): Promise<void>
export async function reorderTemplateSteps(templateId: string, orderedStepIds: string[]): Promise<void>
```

- [ ] **Step 1: Failing tests** — name `.trim().min(1).max(120)` (blank name 400s; duplicate LIVE name 400s via P2002→`withDbErrors`; re-using a soft-deleted name creates a NEW row — assert new id); `deleteTemplate(id, "")` and whitespace-only reason → `HttpError(400, "A reason is required")`; delete writes the reason into the audit entry; step ops mirror Task 4's shapes minus values (add 400s on deleted code, accepts inactive; boilerplate `.max(4000)`; reorder atomic; remove closes gap); every mutation audits at template level with content (step add visible in after-snapshot); `findFirst` not `findUnique` on name everywhere.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** following `src/server/reference.ts` + Task 4 patterns — every mutation `withDbErrors` → Serializable `$transaction` (step ops assign the registered `codeId` FK) → `audited*` with `tx`. Template step mutations wrap in `auditedUpdate("processTemplate", templateId, …)`.
- [ ] **Step 4: Run tests + gates → PASS. Commit** `feat: process templates service`

---

### Task 6: Load Template

**Files:**
- Modify: `src/server/part-process-steps.ts`
- Test: `tests/part-process-steps.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 4 + 5.
- Produces: `export async function loadTemplate(partId: string, templateId: string): Promise<{ revisionNumber: number }>`

- [ ] **Step 1: Failing tests** (each a real `it`):
  - **Structure only, never values**: template of 3 steps (one with boilerplate "load per racking sheet", built on codes carrying defs) → `loadTemplate` → working revision has exactly 3 steps, `instruction === boilerplate`, and `prisma.partProcessStepValue.count()` for those steps is **0**.
  - **Replace**: part had 2 steps with values → after load, they are gone (and their value rows deleted); only template structure remains.
  - **Locked current survives**: lock rev 1 (2 steps) → `loadTemplate` → returns `revisionNumber: 2`; rev 1 re-reads byte-identical; rev 2 holds the template structure.
  - **Refusals**: soft-deleted template → 404 `"Template not found"`; inactive template → 400 `"That template is inactive"`.
  - **Audit**: the load is one revision-level update whose after-snapshot lists the template's steps.
- [ ] **Step 2: Run → FAIL. Step 3: Implement**: Serializable tx → `workingRevision` → fetch template `findFirst({ id, deletedAt: null }, include steps+ordered)`, refuse per above → inside one `auditedUpdate` on the revision: delete all existing step values + steps of the working revision, then create one step per template step (`position` copied, `codeId` copied — `assertRefExists` each distinct code, `instruction: templateStep.boilerplate`, zero values).
- [ ] **Step 4: Run + gates → PASS. Commit** `feat: load template replaces working revision structure, never values`

---

### Task 7: Step-code delete guard

**Files:**
- Modify: `src/server/process-step-codes.ts` (`deleteStepCode`)
- Create: `src/app/api/admin/step-codes/[id]/blockers/route.ts`, `src/app/api/admin/step-codes/[id]/blockers/export/route.ts`
- Test: `tests/process-step-codes.test.ts` (extend)

**Interfaces:**
- Consumes: `findBlockers("processStepCode", id, tx)` (Task 2); `deleteReference`'s shape (`src/server/reference.ts:202` — Serializable, blocker count in the 400 message, `auditedSoftDelete`).
- Produces: `deleteStepCode(id)` refusing with `HttpError(400, "That process step code is still in use by N record(s)")`; `GET …/blockers` → `Blocker[]`; `GET …/blockers/export` → xlsx. Both admin routes mirror the existing reference blocker routes exactly (find them under `src/app/api/admin/reference/` and copy their gating — same `mustCan` area/action — and their `toXlsx` column shape).

- [ ] **Step 1: Failing tests** — guard matrix: blocked by a current-revision step; by a locked-historical step ONLY (owner ruling §3.2); by a template step; NOT blocked by steps under a soft-deleted part or template; a code with no references soft-deletes cleanly (and its audit entry says delete); dedupe (two revisions → the blocker list from `findBlockers` names the part once — already proven in Task 2, here assert the 400 count matches the deduped list length).
- [ ] **Step 2: Run → FAIL. Step 3: Implement** `deleteStepCode` by transplanting `deleteReference`'s transaction shape verbatim with target `"processStepCode"` and label from `TARGET_LABELS`. Add the two admin routes mirroring the reference blocker/export routes.
- [ ] **Step 4: Route tests** for the two new endpoints (401 unauthenticated; 403 without the mirrored admin permission; 200 shape). **Step 5: gates → PASS. Commit** `feat: step-code deletion blocked with discoverable blockers`

---

### Task 8: Steps routes + step-code-fields route

**Files:**
- Create: `src/app/api/parts/[id]/process/revisions/route.ts`, `…/revisions/[n]/route.ts`, `…/process/steps/route.ts`, `…/process/steps/[stepId]/route.ts`, `…/process/reorder/route.ts`, `…/process/load-template/route.ts`, `src/app/api/process/step-code-fields/route.ts`
- Test: `tests/part-process-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 4 + 6 services.
- Produces the spec §9 route table exactly. Every steps route: `mustCan(requireUser(), "processes", "view" | "edit")` per the table. `step-code-fields`: `requireUser()` only, returns `{ id, code, name, active, fields: { id, label, type, unit, sort }[] }[]` for LIVE codes (fields sorted by `sort`).

- [ ] **Step 1: Failing route tests.** Mirror the request-building idiom of the existing parts route tests (open `tests/` and reuse whatever helper they use with `signInWith`). Cover, for EVERY route: 401 with no cookie; 403 with a session lacking the gate (e.g. `signInWith(["parts.view"])` hitting a `processes.view` route); success shape for the happy path. Example for one route (repeat the pattern):

```ts
import { GET as revisionsGET } from "@/app/api/parts/[id]/process/revisions/route";
const res = await revisionsGET(
  new Request("http://t/api/parts/x/process/revisions", { headers: { cookie } }),
  { params: Promise.resolve({ id: part.id }) },
);
expect(res.status).toBe(200);
```

Also: PATCH step body rejects unknown keys (`.strict()`); DELETE step with a null body works (2C-2's null-body DELETE precedent); load-template 400/404 pass through as JSON errors.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** all seven route files on the Task-8 pattern (`handle` → `mustCan` → zod parse → delegate → `NextResponse.json`). `step-code-fields` queries `prisma.processStepCode.findMany({ where: { deletedAt: null }, orderBy: { code: "asc" }, include: { fields: { orderBy: { sort: "asc" } } } })` and maps the projection; no `.catch(() => {})` anywhere.
- [ ] **Step 4: Run + full gates → PASS. Commit** `feat: process steps and step-code-fields routes`

---

### Task 9: Templates routes + export

**Files:**
- Create: `src/app/api/process-templates/route.ts`, `…/[id]/route.ts`, `…/[id]/steps/route.ts`, `…/[id]/steps/[stepId]/route.ts`, `…/[id]/reorder/route.ts`, `…/export/route.ts`
- Test: `tests/process-template-routes.test.ts`

**Interfaces:**
- Consumes: Task 5 service; `reasonFromBody` (`src/server/http.ts`); `toXlsx` (`src/server/excel.ts`).
- Produces the spec §9 templates route table exactly: GET list/detail `processes.view`; POST create `processes.create`; PATCH `processes.edit`; DELETE `processes.delete` with `reasonFromBody`; step ops `processes.edit`; export `processes.view` with columns `Name`, `Active`, `Steps` (count).

- [ ] **Step 1: Failing tests** — 401/403 for every route+method (the 2C-2 16-pair precedent: enumerate them); DELETE without a reason → 400; export returns an xlsx content-type and a buffer that parses (mirror the existing export route tests' assertion).
- [ ] **Step 2: Run → FAIL. Step 3: Implement** mirroring the customers routes' shapes. **Step 4: Run + gates → PASS. Commit** `feat: process template routes and export`

---

### Task 10: ProcessStepsSection on the part detail page

**Files:**
- Create: `src/app/parts/[id]/ProcessStepsSection.tsx`
- Modify: `src/app/parts/[id]/page.tsx` (mount in the slot between `<CustomFieldsSection …/>` and the `HistoryPanel` block, same props idiom: `partId`, `perms`, `onError`)

**Interfaces:**
- Consumes: Task 8 routes; `gate` from `@/lib/permission-ui`; `api` from `@/lib/fetcher`; the section-component conventions of `CustomFieldsSection.tsx` (load via `useCallback` + `useEffect`, `onError` reporting, no reload-after-error banner clears — HANDOFF §5.13).
- Produces: the spec §10 designer. No new server code.

- [ ] **Step 1: Build the component.** State: `revisions: RevisionSummary[]`, `selected: number | null` (defaults to highest), `detail: RevisionDetail | null`, `codes` (from `/api/process/step-code-fields`), `templates` (from `/api/process-templates`, active only). Render: revision `<select>` + badge (`Rev N · working` / `Rev N · locked`); the ordered step list — per step: `CODE — name` label, instruction `<textarea>`, and per field def an input by type (NUMBER/TEXT → `<input>`, DATE → `<input type="date">`, CHECKBOX → `<input type="checkbox">` mapping to `"true"`/`"false"`); Add step (code `<select>` of active codes → POST steps); per-step Remove and ▲/▼ reorder buttons (POST reorder with the full id order); Save per step (PATCH instruction+changed values, diffed like `CustomFieldsSection`'s `original` map); **Load Template**: template `<select>` + button → `confirm("Replace the current steps with this template's blank skeleton?")` → POST load-template. Every mutation response carries `revisionNumber` — if it differs from `selected`, reload the revision list and switch to it (that is how a silent cut becomes visible). Gating (§5.16): all mutating controls `disabled={!canEdit.allowed} title={canEdit.title}` with `const canEdit = gate(perms, "processes.edit")`; a non-current selected revision renders every control disabled with title "Superseded revision — read-only"; a user whose revisions fetch 403s sees the section frame with "Requires processes.view" in place of data.
- [ ] **Step 2: Mount it** in `page.tsx` (one line in the slot; pass the same `perms`/`onError` the neighbors get).
- [ ] **Step 3: Verify live** — `npm run dev`, drive the page with the Chrome DevTools MCP (or the §5a Playwright fallback): add a step on a seeded part, fill a NUMBER field, reload, value persists; screenshot. Clean the dev-DB fixtures afterward.
- [ ] **Step 4: Full gates (`npm run build` included) → PASS. Commit** `feat: process steps designer on the part detail page`

---

### Task 11: Processes pages + nav

**Files:**
- Create: `src/app/processes/page.tsx`, `src/app/processes/templates/[id]/page.tsx`
- Modify: `src/components/Shell.tsx` (nav entry `Processes → /processes`, shown for `processes.view` — copy the exact conditional idiom of the existing Parts entry)

**Interfaces:**
- Consumes: Task 9 routes; `useLatest` (`@/lib/use-latest`) on the list fetch; `usePermissions`/`gate`; `HistoryPanel`.
- Produces: spec §10's pages.

- [ ] **Step 1: Templates list page** — mirror the parts list page's structure exactly (search-as-you-type over name, column sort, active-only toggle, Export link to `/api/process-templates/export`, Add button gated `processes.create`, `useLatest` wrapping the fetch, errors reported not swallowed). Row click → `/processes/templates/[id]`.
- [ ] **Step 2: Template detail page** — client component, remounts per record (`<Detail key={id}>`, HANDOFF §5.12). Name input + Save (`processes.edit`), Active toggle, step editor (Add step from active-codes select via `/api/process/step-code-fields`; per step: `CODE — name`, boilerplate textarea, Remove, ▲/▼), Delete button gated `processes.delete` → `prompt("Reason for deleting this template:")`, refuse empty client-side AND rely on the service 400; `HistoryPanel entity="processTemplate" entityId={id}`.
- [ ] **Step 3: Nav entry** in `Shell.tsx`.
- [ ] **Step 4: Verify live** (dev server + browser): create a template with two steps, rename it, see history; screenshot; clean fixtures. **Full gates → PASS. Commit** `feat: processes pages — template list and detail`

---

### Task 12: Step-codes admin page completion (the §6 backlog)

**Files:**
- Modify: the step-codes admin page (locate it under `src/app/admin/` — it is the page that renders step codes with field defs) and, if it calls `updateStepCodeWithFields`, keep that call shape (Task 3 preserved the API).

**Interfaces:**
- Consumes: Task 3 (`stepFieldBlockers`), Task 7 (blocker routes), `BlockerPanel` (`@/components/BlockerPanel` — props `{ label, rowName, list, exportHref, onDismiss }`), `HistoryPanel`.
- Produces: delete, active toggle, history, and blocker-aware field editing on the admin page.

- [ ] **Step 1: Add Delete** per row (gated on the same admin permission the reference grids' delete uses — copy their gate key): on 400, fetch `/api/admin/step-codes/[id]/blockers` and render `BlockerPanel` with `exportHref` to the export route.
- [ ] **Step 2: Add an Active toggle** (existing `updateStepCode` supports `active`) and a `HistoryPanel entity="processStepCode"` on the selected row, mirroring how the reference grids place theirs.
- [ ] **Step 3: Field-def editing** — surface Task 3's 400s: when a field save fails because values exist, show the error text; keep ids on existing rows in the payload so edits stay id-preserving (add a hidden id per row if the page currently rebuilds fields without ids).
- [ ] **Step 4: Verify live** (browser): delete refusal shows the panel naming a part; export downloads; toggle + history render. Screenshot; clean fixtures. **Gates → PASS. Commit** `feat: step-codes admin page — delete with blockers, active toggle, history`

---

### Task 13: E2E harness + flows (owner deliverable, spec §12)

**Files:**
- Create: `e2e/run.mjs`, `e2e/flows/` (one module per flow), `.gitignore` entry `/e2e-artifacts`
- Modify: `package.json` (devDependency `playwright` pinned exact; script `"test:e2e": "node e2e/run.mjs"`), `README.md` (one-time `npx playwright install chromium`; `HEADED=1 npm run test:e2e` to watch)

**Interfaces:**
- Consumes: the running app (`npm run dev`, dev DB `erp`); HANDOFF §5a traps (controlled inputs expose no `value` attribute — locate by label/index; two "Search" boxes exist — scope selectors; dump inputs before guessing).
- Produces: `npm run test:e2e` → runs all flows headless (headed with `HEADED=1`), writes `e2e-artifacts/<flow>/<nn>-<checkpoint>.png` + `video.webm`, exits non-zero on any failure, and **cleans every fixture it created out of the dev DB** (delete in FK order via a finally block using prisma — `erp`, never `erp_test`).

- [ ] **Step 1: Harness** — `run.mjs`: `npm install playwright` (pinned) beforehand; launch `chromium.launch({ headless: !process.env.HEADED })`; `browser.newContext({ recordVideo: { dir } })`; start `next dev` on port 3100 as a child process (env `PORT=3100`) and poll `http://localhost:3100/login` until ready; log in as `admin`/`admin`; run each flow in sequence with numbered screenshots; kill the dev server; cleanup in `finally`.
- [ ] **Step 2: The six flows** (spec §12, each a module exporting `run(page, shot)`):
  1. `template-build-and-load` — create template "E2E Austemper" with 2 steps + boilerplate; open a created part; Load Template; **assert the confirm dialog appeared** (`page.on("dialog")`), accept; steps render with boilerplate text and empty fields.
  2. `typed-fields` — fill a NUMBER field and a CHECKBOX on a step; save; reload; values persisted and render in typed inputs.
  3. `revision-cut` — lock rev 1 via a direct service call from the harness (import is not possible in the browser — use `node` against `src/server` OR flip `lockedAt` with prisma from the harness, documented as standing in for Phase 3's order save); edit a step; UI shows `Rev 2 · working`; switch the picker to Rev 1 — read-only and unchanged.
  4. `blocked-code-delete` — attempt deleting the used step code in admin; BlockerPanel names the part; screenshot; Export link responds 200.
  5. `permission-gating` — create a role/user holding `parts.view`+`processes.view` only (via the admin UI or prisma); log in as them; the designer renders with every mutating control disabled and tooltips naming `processes.edit`.
  6. `processes-list` — templates list: search narrows, export downloads, Add disabled for the restricted user.
- [ ] **Step 3: Run it** — `npm run test:e2e` → all six pass, artifacts present. Attach/report the artifact paths.
- [ ] **Step 4: Commit** `feat: playwright e2e harness with owner-reviewable artifacts`

---

### Task 14: Demo walkthrough + docs

**Files:**
- Modify: `README.md` (if anything beyond Task 13's edit is needed), nothing else — HANDOFF/CLAUDE.md updates happen post-merge per ritual.
- Create: `docs/2026-08-XX-2c3-demo.md` (dated for the day it runs)

- [ ] **Step 1: Full gates on the branch** — `npm test` (record the count), `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`, plus `npm run test:e2e`.
- [ ] **Step 2: Demo doc** — a walkthrough the owner can follow in ten minutes: seed state, each §12 flow with its artifact screenshot referenced by path, and the owner-ruling behaviors called out (confirm-replace, blocked delete with export, rename propagation, revision cut). Offer a live headed run (`HEADED=1`) and/or a Chrome-MCP-driven walkthrough in the owner's own browser.
- [ ] **Step 3: Commit** `docs: 2C-3 demo walkthrough`

---

## Self-review (performed at write time)

- **Spec coverage:** §4→Task 1; §7→Task 2; §6→Tasks 3, 12; §5→Task 4; §8→Tasks 4–6; §3.1→Tasks 6, 10, 13; §3.2→Task 7; §9→Tasks 7–9; §10→Tasks 10–12; §11 clusters 1–8→Tasks 4, 6, 7, 3, 4, 4/5, 1/2, 4; §12→Task 13; §13 order honored (schema moved ahead of the registry because the registry's entries name Task 1's models); §14 respected (nothing builds orders, cert columns, copies, or paste).
- **Type consistency:** `BlockerTarget`/`TARGET_LABELS` (Task 2) consumed by Tasks 4–7; `RevisionSummary`/`RevisionDetail`/`StepRow` (Task 4) consumed by Tasks 8, 10; `TemplateSummary`/`TemplateDetail` (Task 5) by Tasks 9, 11; `loadTemplate` (Task 6) by Tasks 8, 10, 13.
- **Known intentional deviations recorded:** step values delete-on-clear (spec §4) diverges from `PartFieldValue`'s keep-`""` precedent — spec §4 wins, the reviewer should not "fix" it; Task 4 runs ALL step mutations Serializable for uniformity of the cut path, a superset of the FK-writer rule.
