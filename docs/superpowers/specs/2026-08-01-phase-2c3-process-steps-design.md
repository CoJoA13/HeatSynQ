# Phase 2C-3 — Process Steps + Templates (design)

**Status: approved by the owner 2026-08-01 (design session in this document's §3).**
Branch: `phase-2c3-process-steps`. The last third of Phase 2C.

Inputs this design answers to: the kickoff brief §2.4, `docs/2026-07-30-process-steps-model.md`
(the owner-decided model and the revision-cut question), and 2C-2's spec §12 (what this phase
inherits). Binding context: the approved spec's §3 non-goals and §15 decision log, HANDOFF §5
conventions (§5.14 blocked-deletes-name-blockers, §5.15 pick-list reads, §5.16 disabled-not-hidden,
§5.17 delete reasons), and `CLAUDE.md`.

## 1. Goal

A part owns its recipe: an ordered, revisioned list of Process Steps, each naming a shared
Process Step Code and carrying this part's instruction text and typed field values. Revisions are
immutable once locked; editing after a lock cuts revision N+1. Templates are shop-built blank
skeletons — ordered step codes plus boilerplate text, never values — loadable onto a part.
Step codes get real deletion protection (blocked with discoverable blockers, §5.14 shape) via a
generalized registry, without becoming a reference kind.

## 2. Scope

IN: five new models (revision, step, step value, template, template step); steps/templates
services + routes; the Process Steps designer on the part detail page (reserved slot between
custom fields and history); the Processes nav page with templates list + detail; step-code
delete guard + the step-codes admin page's owed backlog items (delete with blockers, active
toggle, HistoryPanel, `.strict()` on `FIELD`); registry generalization (`processStepCode` as a
blocker target); `lockRevision` exported for Phase 3; Excel export for the templates list;
Playwright E2E coverage of the new UI (owner-visible artifacts — §13).

OUT (§14 lists the full set): order coupling beyond `lockRevision`, cert-template columns,
copy-from-another-part, revision deletion, paste for templates/steps, step-level pricing.

## 3. Owner decisions, 2026-08-01 (this design session)

1. **Load Template onto a part that already has steps: replace, with confirm.** The dialog
   states the existing steps will be replaced by the template's blank skeleton; on confirm the
   working revision's steps are wiped and the template structure loads. (Append and
   only-when-empty were considered and rejected.)
2. **Step-code deletion is blocked on ANY live use** — current revision, locked historical
   revision, or template. The blocker panel names the parts/templates and, when the only
   blockers are historical, says to deactivate instead. Deletion stays what it is for: codes
   typed by mistake and never really used. History never renders a deleted code.
3. **Renames propagate everywhere; values stay frozen.** Steps and values reference the live
   vocabulary (code name, field label/unit) — renaming a code or relabeling a field shows
   everywhere, including locked revisions and future traveler reprints. What immutability
   freezes is the recipe's VALUES (temperatures, times, text), not the vocabulary's spelling.
   Consequence: **no denormalized display columns** on steps or values. Decision 2 is what
   makes this safe — a used code can never be deleted, so history never dangles.
4. **The delete guard generalizes the registry** rather than living in the step-code service:
   the registry's target axis widens beyond `ReferenceKind`, the two new FKs become ordinary
   registry entries, and `findBlockers` stays branch-free (§7).
5. **E2E UI tests are a deliverable, visible to the owner.** Playwright-driven browser coverage
   of the new UI flows, with screenshots/video the owner can review and a headed-run option to
   watch live (§13). Added to the definition of done.

## 4. Data model

All new tables are additive; no existing column changes. One hand-written migration
(`migrate diff`, TTY constraint), applied to both databases. Partial `@@unique` lines stay
single-line (sweep limitation, HANDOFF §5.11).

```prisma
model PartProcessRevision {
  id             String            @id @default(cuid())
  partId         String
  part           Part              @relation(fields: [partId], references: [id])
  revisionNumber Int
  lockedAt       DateTime?         // set once by lockRevision (Phase 3's order save); null = working
  createdAt      DateTime          @default(now())
  updatedAt      DateTime          @updatedAt
  steps          PartProcessStep[]

  @@unique([partId, revisionNumber])
  @@index([partId])
}
```

- **No `deletedAt`.** Revisions are never deleted — immutable history. Soft-deleting the part
  hides the whole subtree (list/detail/guards all reach revisions only through a live part).
- **The current revision is the highest `revisionNumber` for the part.** No
  `currentRevisionId` pointer to desync.

```prisma
model PartProcessStep {
  id          String                 @id @default(cuid())
  revisionId  String
  revision    PartProcessRevision    @relation(fields: [revisionId], references: [id])
  position    Int
  codeId      String
  code        ProcessStepCode        @relation(fields: [codeId], references: [id])
  instruction String                 @default("")
  values      PartProcessStepValue[]

  @@unique([revisionId, position])
  @@index([revisionId])
  @@index([codeId])
}

model PartProcessStepValue {
  id         String              @id @default(cuid())
  stepId     String
  step       PartProcessStep     @relation(fields: [stepId], references: [id])
  fieldDefId String
  fieldDef   ProcessStepFieldDef @relation(fields: [fieldDefId], references: [id])
  value      String

  @@unique([stepId, fieldDefId])
  @@index([fieldDefId])
}
```

- **Steps and values have no soft delete** (the `PartFieldValue` precedent, 2C-2 §11):
  removing a step from a working revision is an *edit to the revision* — audited as the
  revision's diff — not an entity deletion. Recorded here so a reviewer doesn't read it as an
  oversight against the soft-delete-only rule.
- **Only non-empty values are stored.** Clearing a field deletes its value row; a blank
  template load creates zero value rows.
- **No `onDelete: Cascade` anywhere in the chain** (the §6 latent-trap note): revisions are
  never deleted and parts are soft-deleted, so cascades would only ever fire in tests, and
  `truncateAll()` handles those.

```prisma
model ProcessTemplate {
  id        String                @id @default(cuid())
  name      String
  active    Boolean               @default(true)
  deletedAt DateTime?
  createdAt DateTime              @default(now())
  updatedAt DateTime              @updatedAt
  steps     ProcessTemplateStep[]

  @@unique([name], where: raw("\"deletedAt\" IS NULL"))
}

model ProcessTemplateStep {
  id          String          @id @default(cuid())
  templateId  String
  template    ProcessTemplate @relation(fields: [templateId], references: [id])
  position    Int
  codeId      String
  code        ProcessStepCode @relation(fields: [codeId], references: [id])
  boilerplate String          @default("")

  @@unique([templateId, position])
  @@index([templateId])
  @@index([codeId])
}
```

- **The template model has no value fields at all** — "structure, never values" is structural,
  not policed. `boilerplate` loads into the step's `instruction` on Load Template; that is
  text structure (the model doc's sequence diagram shows it loading), not a value.
- `ProcessStepCode` gains back-relations (`partSteps PartProcessStep[]`,
  `templateSteps ProcessTemplateStep[]`); `ProcessStepFieldDef` gains
  `values PartProcessStepValue[]`. `Part` gains `processRevisions PartProcessRevision[]`.

**Text rules (2C-2 §4 convention):** `ProcessTemplate.name` is a required identifier —
`.trim().min(1).max(120)`. `instruction` and `boilerplate` are optional display text —
`.max(4000)`, no minimum, default `""`. Value strings: `.max(500)`.

**Value typing** (validated at write against the def's `StepFieldType`): `NUMBER` — decimal
string parseable and finite; `DATE` — `yyyy-mm-dd`; `CHECKBOX` — `"true"`/`"false"`;
`TEXT` — free. Field-anchored 400s on mismatch.

## 5. The revision-cut rule (the answer the planner owed, and its tests)

The model doc left one open detail — when a new revision is cut — and directed the planner to
answer and test it. The answer, matching the doc's suggested default:

1. **Revision 1 is created lazily** on a part's first step mutation (add step or Load
   Template). Parts created in 2C-2 have no revisions until then; no backfill.
2. **Every mutation targets the current revision** (highest `revisionNumber`). The client
   never names a revision to mutate; the server decides.
3. **Unlocked current revision → amend in place.** Same revision id, same number, however many
   edits. Initial part setup churns freely inside revision 1.
4. **Locked current revision → the mutation cuts N+1 first**: copy the locked revision's steps
   and values into a new revision (positions, code references, instructions, values —
   everything), then apply the edit to the copy, all inside one transaction. The copy is this part's own
   continuity — it is NOT the banned copy-from-another-part, and the spec says so explicitly
   so no reviewer conflates them.
5. **`lockRevision(partId, revisionNumber, tx)`** is exported from the steps service, sets
   `lockedAt` once (idempotent — a second call is a no-op, not an error), and is called by
   nothing in-app until Phase 3's order save. It exists and is tested NOW so Phase 3 inherits
   a proven primitive.
6. **Immutability is enforced in the service, inside the transaction**: every mutating path
   resolves its target inside the tx and (a) 404s if the named step belongs to a superseded
   revision, (b) cuts N+1 per rule 4 if the current revision is locked (a step named on the
   locked current maps to its copy by position), (c) amends in place otherwise. There is no
   code path that writes to a locked revision's steps or values.

Tests (the densest cluster in the phase): amend-in-place keeps id and number; post-lock edit
creates N+1 with the full copied content plus exactly the one change; the locked revision's
steps and values are byte-identical before and after; `lockRevision` is idempotent; Load
Template onto a locked current revision cuts N+1 (then replaces); viewing any historical
revision returns its content unchanged.

## 6. Field-def rules (2C-2 precedent extended)

`ProcessStepFieldDef` becomes value-bearing, so it inherits the part-field-def rules:

- **Delete and type-change are blocked while any `PartProcessStepValue` references the def** —
  locked revisions included (same logic as §3 decision 2), with a blocker panel naming the
  parts (deduped) and Excel export.
- **Label and unit edits stay free** and propagate everywhere (§3 decision 3).
- `setStepFields`'s wholesale replace would orphan values — it is reworked to **id-preserving
  row edits** (the 2C-2 `part-field-defs` service/admin pattern: add, edit, delete, reorder as
  distinct operations). The step-codes admin page adopts the matching row-edit UI.
- `FIELD` (the one schema without `.strict()`, §6 backlog) gets `.strict()`; the step-codes
  page is updated for whatever that surfaces.

## 7. Registry generalization — step codes as a blocker target

The registry's target axis widens from `ReferenceKind` to a `BlockerTarget`:

```ts
export type BlockerTarget = ReferenceKind | "processStepCode";
```

`targetKind` on `ReferenceLink` becomes `BlockerTarget`; `linksTargeting`/`findBlockers` take
`BlockerTarget`. Pick-list logic is untouched (it never derived from `targetKind`'s type).
Two new entries:

- `{ model: "partProcessStep", column: "codeId", targetKind: "processStepCode", ... }` —
  presents its **Part** (blockerId → part id through `revision.part`, `displayName` =
  `CODE · partNumber` via the existing `partLabel`, `detailPath` → `/parts/[id]`). A part
  using a code in five revisions lists **once** (existing `blockerId` dedupe).
- `{ model: "processTemplateStep", column: "codeId", targetKind: "processStepCode", ... }` —
  presents its **Template** (name, `detailPath` → the template detail page).

**One mechanism extension: `liveWhere`.** `findBlockers` hardcodes `deletedAt: null`, but
neither new model has that column — their liveness is inherited. Entries gain an optional
`liveWhere?: Record<string, unknown>` (default `{ deletedAt: null }`):
`partProcessStep` uses `{ revision: { is: { part: { is: { deletedAt: null } } } } }`;
`processTemplateStep` uses `{ template: { is: { deletedAt: null } } }`. `findBlockers` spreads
the entry's filter instead of the literal — still zero model branches.

`deleteStepCode` adopts `deleteReference`'s guarded shape: Serializable transaction, blocker
scan, refuse-with-list or soft-delete. `assertRefExists` widens to `BlockerTarget` so step and
template-step writers assigning `codeId` get the same in-tx existence check and Serializable
scope as every registered-FK writer (a soft-deleted code by raw id 400s; an **inactive** code
is accepted — 2C-2 semantics: inactive hides from pick-lists, it does not invalidate
assignment). The links sweep (`tests/reference-links-sweep.test.ts`) extends to fail on any
schema FK targeting `ProcessStepCode` that is missing from the registry.

## 8. Services

`src/server/part-process-steps.ts`:

- `getRevisions(partId)` — numbers + `lockedAt` + step counts, newest first.
- `getRevision(partId, revisionNumber)` — full content: ordered steps, each with live code
  (`code`, `name`), instruction, and values joined to live defs (label/type/unit).
- `addStep(partId, { codeId, instruction?, values? })`, `updateStep(partId, stepId, ...)`,
  `removeStep(partId, stepId)`, `reorderSteps(partId, orderedStepIds)` — all operate on the
  current revision under §5's rules; reorder is the 2C-2 two-phase atomic pattern (positions
  parked negative, then finalized) against `@@unique([revisionId, position])`.
- `loadTemplate(partId, templateId)` — replaces the working revision's steps with the
  template's structure: one step per template step, `instruction` = `boilerplate`, zero value
  rows. Cuts N+1 first if the current revision is locked. Refuses a soft-deleted or inactive
  template (a template is picked live from a list, not held as a stored assignment — nothing
  references templates, so unlike code assignment there is no §5.14 inactive-stays-valid case).
- `lockRevision(partId, revisionNumber, tx)` — §5.5.

`src/server/process-templates.ts`: `listTemplates`, `getTemplate`, `createTemplate`,
`updateTemplate` (name, active), `deleteTemplate(id, reason)` — **reason required, trimmed,
enforced in the service** (§5.17 classification: deleting a template carries its steps away
and frees a unique name — same footing as role); template step add/edit/remove/reorder
mirroring the steps service minus values.

Every mutation goes through the required-`tx` audited helpers. New `AuditableModel` entries:
`partProcessRevision` and `processTemplate`, with `SNAPSHOT_INCLUDE` pulling ordered steps
(with code selects) and values (with def selects) into snapshots — step and value edits are
audited as **revision-level updates with meaningful diffs**, template-step edits as
template-level updates. Tests assert audit **content** (the §6 "assert content, not actions"
note), not just that an entry exists.

## 9. Routes

All follow authorize → parse → delegate. Steps designer (part pages, `processes` area — the
spec's `templates` area stays reserved for Phase 7 document templates; step codes stay under
`admin`):

| Route | Method | Gate |
|---|---|---|
| `/api/parts/[id]/process/revisions` | GET | `processes.view` |
| `/api/parts/[id]/process/revisions/[n]` | GET | `processes.view` |
| `/api/parts/[id]/process/steps` | POST | `processes.edit` |
| `/api/parts/[id]/process/steps/[stepId]` | PATCH, DELETE | `processes.edit` |
| `/api/parts/[id]/process/reorder` | POST | `processes.edit` |
| `/api/parts/[id]/process/load-template` | POST | `processes.edit` |

Editing a recipe is editing one thing — every step mutation is `processes.edit`; there is no
create/delete split to misassign. Templates map CRUD naturally:

| Route | Method | Gate |
|---|---|---|
| `/api/process-templates` | GET | `processes.view` |
| `/api/process-templates` | POST | `processes.create` |
| `/api/process-templates/[id]` | GET | `processes.view` |
| `/api/process-templates/[id]` | PATCH | `processes.edit` |
| `/api/process-templates/[id]` | DELETE (reason in body) | `processes.delete` |
| `/api/process-templates/[id]/steps` + step ops | POST/PATCH/DELETE | `processes.edit` |
| `/api/process-templates/export` | GET | `processes.view` |

Session-gated read (the §5.15 shape — vocabulary, not secrets; the pick-list projection stays
narrow by design, so this is a separate route, not a widening):

| Route | Method | Gate |
|---|---|---|
| `/api/process/step-code-fields` | GET | `requireUser` only |

Returns live codes (`id`, `code`, `name`, `active`) each with field defs (`id`, `label`,
`type`, `unit`, `sort`) — what the designer needs to render dynamic fields. Failed fetches
report; no `.catch(() => {})`.

Step-code guard surface (existing admin routes): DELETE on a step code returns the §5.14
refusal shape (blocker list) and the admin page gains the BlockerPanel + blocker Excel export.

## 10. UI

**Part detail — `ProcessStepsSection`** in the reserved slot between `CustomFieldsSection` and
`HistoryPanel` (2C-2 §12). Contents: revision picker (defaults to current; badge shows
`Rev N · working` / `Rev N · locked`); the ordered step list — each step shows the live code
(`CODE — name`), instruction textarea, and the code's fields rendered by type (NUMBER/TEXT
inputs, DATE picker, CHECKBOX); add step (code picker fed by the pick-list route, fields
appear from `/api/process/step-code-fields`); remove; up/down reorder; **Load Template**
(dropdown of active templates + the §3.1 confirm-replace dialog). Historical revisions render
**read-only** — every control disabled with "Locked revision — editing will create a new
revision" on the current-locked one, and view-only on superseded ones. Permission gating per
§5.16: controls disabled with "Requires processes.edit", never hidden; a user without
`processes.view` sees the section's frame with a message naming that permission in place of
the data (the revisions routes 403 for them). Section follows the part page's error-banner conventions (no reload-after-error clears).

**Processes nav page (`/processes`)** goes live: templates list — search-as-you-type, column
sort, active-only toggle, Excel export, `use-latest` stale-response gate, Add gated on
`processes.create`. **Template detail (`/processes/templates/[id]`)**: name, active toggle,
step editor (code picker + boilerplate textarea per step, add/remove/reorder), Delete with
required-reason prompt (no blocker panel — nothing references templates), `HistoryPanel
entity="processTemplate"`. Detail remounts per record (`key={id}`, §5.12). No paste entry for
templates (not a reference table; out of scope).

**Step-codes admin page** closes its §6 backlog: Delete with BlockerPanel + export, active
toggle, `HistoryPanel`, and the field-def editor becomes id-preserving row edits (§6 of this
spec) with delete/type-change blockers surfaced.

**Left nav**: "Processes" entry appears for users holding `processes.view` (nav continues to
hide-not-disable per §5.16's Shell carve-out).

## 11. Testing

TDD per task; every route 401- and 403-tested; suite target well above 421. The dense
clusters:

1. **Revision-cut** — the six behaviors in §5, each its own test.
2. **Template loads structure, never values** — asserted structurally: after any load, the new
   steps have zero `PartProcessStepValue` rows and instructions equal to boilerplate; a
   template built while codes carried defs still loads no values. Replace semantics: existing
   working steps are gone; a locked current revision survives untouched with N+1 holding the
   template structure.
3. **Guard matrix** — code delete blocked by: current-revision step, locked-historical step,
   template step; NOT blocked by: steps under a soft-deleted part, steps of a soft-deleted
   template; blocker list dedupes a multi-revision part to one row; blocker export matches;
   `deleteStepCode` + concurrent step-add race is covered by the Serializable pattern's
   existing test shape.
4. **Field defs** — delete/type-change blocked while values exist (including only-historical
   values); label/unit edits propagate to historical renders; `.strict()` rejection.
5. **Value typing** — each `StepFieldType` accepts/rejects correctly, field-anchored messages;
   empty-string clears the row.
6. **Audit content** — a step edit produces a revision-level diff showing the actual
   step/value change; template-step edits diff on the template.
7. **Sweeps** — links sweep extended (FKs targeting `ProcessStepCode` must be registered);
   partial-unique sweep picks up `ProcessTemplate.name` automatically.
8. **Immutability** — no service path mutates a locked revision (byte-identical assertions).

## 12. E2E UI verification (owner deliverable, §3 decision 5)

Two lanes, one goal — the owner sees the UI working:

1. **A persistent Playwright harness** under `erp/e2e/`, driven against `npm run dev` with the
   bundled Chromium per HANDOFF §5a (controlled inputs don't expose `value` attributes; dump
   inputs before guessing selectors). Run via `npm run test:e2e`; **not** part of the
   `npm test` vitest gate (needs a live dev server). Artifacts — screenshots at each named
   checkpoint and a video per flow — land in `erp/e2e-artifacts/` (gitignored), for the owner
   to review after every run; `HEADED=1 npm run test:e2e` runs headed so the owner can watch
   live.
2. **Interactive walkthroughs in a real visible browser.** As of 2026-08-01 the Chrome
   DevTools MCP connects on this machine (Chrome extension installed — HANDOFF §5a's
   "MCP browser plugins find no usable Chrome" is stale here; §5a's Playwright fallback
   remains the portable path). Review rounds and the owner demo drive the actual browser, so
   the owner can watch flows click through live rather than only reading screenshots.

Flows covered (each screenshots its end state at minimum): build a template and load it onto a
part (confirm-replace dialog included); fill values and watch typed fields render per code;
lock → edit → see `Rev 2 · working` appear with Rev 1 readable and unchanged; blocked
step-code delete showing the blocker panel + export; permission-gated controls rendering
disabled with tooltips (second, restricted user); the Processes list page search/export.

Dev-database fixtures created by E2E runs are cleaned up afterward (§5a rule — `erp`, not
`erp_test`). The final task of the phase produces the owner demo walkthrough (2C-2 precedent):
the E2E screenshots plus a short narrative, presented for review before merge.

## 13. Task shape (planner refines)

Debt-closure first (2C-2 precedent), then schema, then services, then routes, then UI, then
E2E + demo: (1) registry generalization + `liveWhere` + sweep extension; (2) field-def
row-edit rework + `.strict()`; (3) schema migration; (4) revisions/steps service (revision-cut
tests); (5) templates service; (6) step-code guard + `assertRefExists` widening; (7) routes +
401/403; (8) step-code-fields route; (9) `ProcessStepsSection`; (10) Processes pages;
(11) step-codes admin page completion; (12) exports; (13) E2E harness + flows; (14) demo
walkthrough + docs. Each task independently testable; fresh subagent per task with independent
review (the loop is not ceremony).

## 14. Non-goals

- No order model, no order↔revision snapshot storage — only the exported `lockRevision`.
- No cert-template column on anything (kickoff §2.4.8 offered "nullable column or nothing" —
  nothing; Phase 4 adds its own).
- No copy-from-another-part, no step library, no per-part step overrides, no shared masters
  (removed by decision, not deferral — kickoff §5).
- No revision deletion or manual "cut revision now" button (not in any doc; the cut rule is
  §5).
- No paste entry for templates or steps; no step-level pricing; no scheduling/tracking
  anything.
- No new pick-list kinds; `glAccount` stays admin-only (§5.15).

## 15. What Phase 3 inherits from 2C-3

- `lockRevision(partId, revisionNumber, tx)` — order save calls it inside the order's own
  transaction, then stores `(partId, revisionNumber)` on the order.
- `getRevision(partId, n)` — the traveler renders from it; historical correctness is already
  tested here.
- The orderability check ("a part needs steps before it is orderable", kickoff §2.4.2) is
  Phase 3's to build at order entry: current revision exists and has ≥ 1 step. Nothing stored
  on the part now — it is derivable, and a stored flag would be one more thing to desync.
- The `BlockerTarget` axis — Phase 3+ models that reference step codes or other non-reference
  targets extend the union and the registry, not `findBlockers`.
