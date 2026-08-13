# Task 5 brief — Assignment + print-time resolution

**Branch:** `phase-7-template-designer` (Tasks 1–4 APPROVED; the template service exists with `claimTemplate` exported; suite at 2298).
**Read first:** `CLAUDE.md` (row-locks doctrine; audit nesting; §5.15/§5.16/§5.17 in HANDOFF §5); the spec `docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md` **§5.2 (resolution — walk-to-root ruled at plan time) + §4.1 (assignment invariants) + §7 (gates; clearing needs no reason) + §5.5's last paragraph (the names read, §5.15)**; the plan Task 5 + Global Constraints; **Task 4's report** — its Task 5 notes are binding: claim through the exported `claimTemplate` before writing assignments; mirror setDefault's `publishedVersionId !== null` refusal; `deleteTemplate` blocks on LIVE assignments only, so resolution must filter BOTH `deletedAt`s (assignment's and template's); fixtures via `templateId()`/`templateVersionId()` from `tests/helpers/db.ts`.

## Deliverable

1. **`erp/src/server/template-assignments.ts`**:
   - `assignTemplate(customerId, docType, templateId)` — **claims the template row via `claimTemplate` first** (this closes the delete-vs-assign race: delete claims the same row); refuses a soft-deleted template (404 via the claim), **refuses a template with no published version** (the setDefault mirror, named 400), refuses a docType mismatch (named 400), refuses a soft-deleted/unknown customer (404). Upsert semantics on the partial-unique `(customerId, docType)` — a live assignment for the pair is REPLACED (audited update), else created (audited create). Never `findUnique`/`upsert` on the partial-unique pair — `findFirst` + create/update (the house rule).
   - `clearAssignment(customerId, docType)` — soft delete, audited, **no reason required** (§5.17 classification, spec §7 — say so in a comment).
   - `listAssignments(customerId)` — live assignments with template names, for the customer page (Task 20 consumes).
   - **`resolveTemplateForPrint(tx, docType, customerId)`** — reads on the CALLER's `tx` (print transactions pass theirs): walk the customer's `parentId` chain toward the root (bound the walk — collect visited ids, stop on repeat or null; `assertNoCycle` guards writes but the read must self-bound); at each hop take the live assignment for (customer, docType) **whose template is itself live**; first hit wins; else the docType's default template (`isDefault`, live). Return `{ templateId, versionId, config, logoImage, logoMimeType }` where config is the **backfilled** parse (`validateConfig`) of the published version's stored JSON. **Never null** — if no default exists the DB invariant is broken: throw a plain Error (a bug, not an expected failure — the spec's seed + truncateAll guarantee).
   - **`deleteCustomer` cascade** (`erp/src/server/customers.ts`): the customer's live template assignments join the explicit `auditedSoftDelete` cascade loop (the addresses/contacts pattern — find it in `deleteCustomer` and match its shape exactly).
2. **Routes**:
   - `api/customers/[id]/template-assignments/route.ts` — GET (list; `customers.view`), PUT (assign; `customers.edit` + `mustDo(user, "edit_templates")`), DELETE (clear; same gates). Thin, `.strict()` zod, ctx-typed tests.
   - `api/templates/names/route.ts` — **`requireUser()` ONLY, no area gate** (§5.15 — the customer page's picker must not silently empty for a user without `templates.view`): returns `{ id, name, docType }` of live templates, nothing else (no configs, no counts). Comment the §5.15 reasoning at the gate line, the picklists precedent.

## Tests — `erp/tests/template-assignments.test.ts` (TDD; RED evidence REQUIRED)

- Assign/replace/clear lifecycle with audit content assertions (replace audits an update with before→after template ids).
- Refusals: never-published template; docType mismatch; deleted template (via claim 404); deleted customer; clear of a non-existent assignment → 404.
- **Resolution chain**: own assignment wins; division falls to parent; grandchild walks to grandparent then root (build a 3-deep tree); soft-deleted assignment ignored; assignment to a soft-deleted template skipped (falls onward — Task 4's note); no assignment anywhere → the docType's Standard default; cycle-safety (hand-write a cycle with raw prisma — the read must terminate, not spin).
- **The delete-vs-assign race, RED-VERIFIED** (carried from Task 4): concurrent `deleteTemplate` and `assignTemplate` on the same template — with both claiming, the loser sees the winner's state (assign-after-delete → 404; delete-after-assign → §5.14 blocked-and-named). Remove the claim from the assign path → red, competitor pinned to Read Committed. Transcript in the report.
- `deleteCustomer` cascades assignments (audited per row); a cascaded-away assignment no longer resolves.
- The names route: 200 with a bare session (no permissions at all), projection exactly `{id,name,docType}`, live rows only.
- Route tests pass ctx; permission sweep stays green (the names route's `requireUser`-only gate must satisfy the sweep the way `/api/picklists` does — study how the sweep exempts/recognizes it and follow that pattern; do NOT weaken the sweep).

## Conventions

Four gates watched with real numbers; RED evidence; conventional commits, no attribution trailer; E2E n/a (routes only); update your ledger row; do not touch builders/print paths (resolution's print-side callers arrive in Tasks 7–14).

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-05-report.md`: decisions, RED transcripts (the race especially), gate numbers, deviations, notes for Task 6 (render runtime — independent) and Task 7 (the first resolution consumer). Final message: 5-line summary + report path.
