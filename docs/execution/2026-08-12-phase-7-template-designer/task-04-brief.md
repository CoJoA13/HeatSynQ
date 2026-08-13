# Task 4 brief — The template service: lifecycle, publish, delete

**Branch:** `phase-7-template-designer` (Tasks 1–3 APPROVED; the data layer exists — 34 migrations on both DBs, 8 seeded "Standard" templates re-created by `truncateAll()`; suite at 2240).
**Read first:** `CLAUDE.md` — especially **"Row locks, not isolation levels, guard cross-transaction invariants"**, the audit section, and the handler shape; the spec `docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md` **§5.1 (the whole lifecycle + the publish-vs-print immutability argument) + §4.1's invariants + §7 (permissions/audit/delete classifications)**; the plan Task 4 + Global Constraints; **Task 3's report** (its Task 4 notes: seeded ids are stable `standard-<doctype>`/`-v1` after every `truncateAll()`; drafts on Standard templates start at versionNumber 2; `linksTargeting("documentTemplate")` works today; extend `SNAPSHOT_SELECT.documentTemplateVersion` if the model gains columns); the ledger's carried-minors — **three Task 3 minors are yours as pre-steps**. Study `src/server/part-process-steps.ts`'s `lockCurrentRevision` (the claim-then-act precedent this service mirrors) and one existing service end-to-end (e.g. `quotes.ts`) for the house shapes.

## Pre-steps (carried from Task 3's review)

1. Pin the five `jsonb_set` target paths in `tests/template-seed.test.ts` (`expect(SQL).toContain("'{textBlocks,cert_statement}'")` etc.).
2. Export the `templateId()`/`templateVersionId()` seed-id helpers once from `tests/helpers/db.ts`; the drift guard imports them (your fixtures will too).
3. (Optional, cosmetic) scope the `not.toContain("1-30")` ban to the statement literal.

## Deliverable — `erp/src/server/templates.ts` + routes

**The service.** Every mutation inside `withDbErrors` → `$transaction` → `audited*` on `tx` (the canonical nesting); every template mutation **claims the template row first** (`SELECT … FOR UPDATE`, the `lockCurrentRevision` shape). Expected failures are field-anchored `HttpError`s; `TemplateConfigError` from `validateConfig` maps to a 400 naming the offending key.

1. **`createTemplate(docType, name)`** — creates the template AND opens its v1 DRAFT in one transaction (spec §5.1), config pre-filled from `DEFAULT_CONFIG`. Name uniqueness per type among live rows (partial-unique; `findFirst` + P2002 hygiene, never `findUnique` on the partial column).
2. **`renameTemplate(id, name)`** — claimed, audited.
3. **`openDraft(id, { fromVersion? })`** — under the claim: refuse if a live DRAFT exists (named 400); allocate `versionNumber` = max(existing)+1; copy config + logo from the explicit source version (`fromVersion` — the §5.1 revert flow; must be a PUBLISHED version of THIS template), else the current published version, else `DEFAULT_CONFIG`.
4. **`editDraft(id, { config, updatedAt })`** — validate via `validateConfig` (the backfilled result is what's stored); **the `updatedAt` precondition**: the caller sends the draft `updatedAt` it loaded; a mismatch is a named 409 ("draft changed since you loaded it"), never a silent merge. Audited with real before→after config diffs.
5. **`discardDraft(id)`** — status flip to `DISCARDED` (audited). NEVER a delete.
6. **`publishDraft(id)`** — under the claim: the draft flips to `PUBLISHED` + `publishedAt`/`publishedById` (actor from context), `publishedVersionId` moves to it, atomically. No draft → named 400.
7. **`setDefault(id)`** — under the claim: **refuse a template with no published version** (§4.1's invariant — a never-published template can be neither default nor assigned); clear the old default + set the new one in the same transaction (the address-default normalization precedent); audited both sides.
8. **`deleteTemplate(id, reason)`** — under the claim: reasoned (§5.17 — trimmed, non-empty, enforced in the service); **refused while it is the current default** (named 400: set another default first); **§5.14-blocked when live `CustomerTemplateAssignment` rows point at it** — refuse and NAME the assigned customers (use `linksTargeting("documentTemplate")`/the registry entry from Task 3), with the Excel blocker export route (copy the house blocker-export shape). Soft delete; versions untouched (append-only history).
9. **`uploadLogo(id, bytes, mimeType)` / `clearLogo(id)`** — DRAFT only (named 400 otherwise); magic-byte sniff PNG/JPEG (reuse the existing signature-upload sniff helper — find it via the #49 fix in `users.ts`; extract/share rather than duplicate if practical); 512KB cap; audited (the snapshot excludes `logoImage` via Task 3's `SNAPSHOT_SELECT` — verify the audit payload carries no bytes).
10. **Reads**: template list (per docType, with default flag + live-assignment counts), template detail (published version + draft + version history — history WITHOUT config bodies in the list projection; a version-detail read returns one config).

**Routes** (thin: `mustCan`/`mustDo` first line, `.strict()` zod, delegate): `api/templates` (GET list `templates.view`, POST create `templates.create`), `api/templates/[id]` (GET view / PATCH rename `templates.edit` / DELETE `templates.delete`), `api/templates/[id]/draft` (POST open / PATCH edit / DELETE discard — `templates.edit`), `api/templates/[id]/publish` (POST — `templates.edit` **+ `mustDo(user, "edit_templates")`**), `api/templates/[id]/default` (POST — `templates.edit` + `mustDo edit_templates`), `api/templates/[id]/logo` (POST/DELETE — `templates.edit`), `api/templates/[id]/blockers/export` (GET — `templates.view`). **Preview and customer assignment are NOT this task** (Tasks 19 and 5). Route-handler tests pass ctx (`{ params: Promise.resolve({...}) }`).

## Tests — `erp/tests/templates.test.ts`, `template-routes.test.ts` (TDD; RED evidence REQUIRED)

- Full lifecycle: create→edit→publish→re-draft→publish v(n+1)→revert-from-v1→discard; version history correct; seeded Standard templates usable as fixtures (stable ids from the shared helper).
- **Version immutability**: no service path updates a PUBLISHED row's config/logo — prove by attempting every mutation against a published version and asserting refusal (and grep-level: the service never issues an update keyed on a PUBLISHED row).
- **The never-published invariant**: `setDefault` refuses a never-published template (assignment's refusal is Task 5's).
- **Concurrency, RED-VERIFIED** (the house rule: remove the guard → red, competing caller pinned to Read Committed): (a) two concurrent `openDraft` → exactly one DRAFT; (b) concurrent `publishDraft` × 2 → one wins, one named 400; (c) publish-vs-openDraft → no torn state; (d) **publish atomicity for readers**: a concurrent reader (any isolation) never observes a `publishedVersionId` pointing at a non-PUBLISHED row — the §5.1 immutability argument's testable half. (The delete-vs-assign race test lands in Task 5 with the assignment writer.)
- The `updatedAt` 409 (stale draft edit refused, fresh one succeeds); discard is a status flip (row still present, history intact).
- Delete: reason required (trimmed); refused for the default; refused-and-naming with live assignments (create assignment rows via raw prisma fixtures — the service arrives in Task 5); Excel export streams.
- Logo: PNG/JPEG magic-byte accept, declared-MIME-lies rejected (#49's lesson), 512KB cap, DRAFT-only, audit payload byte-free.
- Audit content assertions (the house rule: diffs, not just actions): a draft edit's audit row carries the config before→after.
- Permission sweep picks up the routes (it runs automatically — make sure it passes).

## Conventions

Four gates watched with real numbers; conventional commits, no attribution trailer; E2E n/a (routes only — no existing Playwright flow touches them; the UI comes in Task 16); update your ledger row; do not touch the builders, print paths, or `template-assignments` (Task 5).

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-04-report.md`: service-shape decisions, the RED evidence snippets (especially the concurrency guards), gate numbers, deviations with reasons, notes for Task 5 (assignment + resolution build directly on your claim discipline). Final message: 5-line summary + report path.
