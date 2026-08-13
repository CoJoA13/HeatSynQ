# Task 2 brief — The `endingStatement` reference kind (spec ruling 13)

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-10 · **Depends on:** Task 1 (merged on-branch — the `EndingStatement` model, migration, and the temporary bare-`BlockerTarget` pull-forward exist)

**Binding documents (read in this order):**
1. `CLAUDE.md`.
2. `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` — §4.1 (the `EndingStatement` bullet), §3 ruling 13.
3. `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` — Global Constraints + Task 2.
4. `docs/execution/2026-08-10-phase-6-quoting/task-01-report.md` — deviations 3 and 5: Task 1 left temporary endingStatement wiring (a bare `BlockerTarget`, an `AuditableModel` entry, and cleanup comments at three sites) that THIS task must absorb into the real reference-kind wiring.

**Deliverable:** `endingStatement` as the eleventh full reference kind — admin CRUD via the generic machinery, `text` + `isDefault` extra columns, at-most-one-live-default normalization, picklist read, Excel export/paste — TDD, committed conventionally (no trailer).

## What to build (plan Task 2)

1. **Constants + wiring:** `REFERENCE_KINDS` + `REFERENCE_LABELS` ("Ending statement" / "Ending statements"), `PICKLIST_KINDS` (quote entry reads it with a session — §5.15), `EXTRA_SCHEMAS` in `reference.ts` (`text` max 4000 like `commentSnippet`, `isDefault` boolean), the extra-columns UI config the generic admin reference page + Excel export/paste read (follow `commentSnippet`'s text handling; `isDefault` needs whatever the config's boolean shape is — study how existing boolean-ish columns render before inventing one; if no boolean precedent exists in the grid, the house pattern decision is yours to make MINIMALLY and document). Absorb Task 1's three commented temporary sites (reference-links bare BlockerTarget → however the registry represents real kinds; keep enforcement equal or stronger).
2. **Default normalization in the service** (spec: at most one live default, the address-default precedent — find and follow the actual normalizer shape in `customers.ts`/addresses): a create/update/paste setting `isDefault: true` clears every other live row's flag in the same transaction, audited; deactivating/deleting the default leaves the kind defaultless (legal — `Quote.endingStatementId` is nullable). Enforce in the SERVICE so no future caller bypasses (§5.17 discipline). Concurrency: two concurrent "make me default" writes must end with exactly ONE live default — claim or conditional-update, and RED-verify the test by removing the guard and pinning the competing caller to Read Committed (the house rule: a passing concurrency test is not evidence).
3. **Tests (TDD):** kind CRUD through the generic reference routes; default normalization incl. the concurrent case; picklist projection includes the kind (and still excludes `glAccount`); export/paste round-trip for the extra columns; the reference sweeps green with the temporary Task 1 shims gone.

## Hard constraints

- Commands from `erp/`. Do not touch `erp/.claude/`.
- No schema change should be needed (Task 1 shipped the model). If you find one is genuinely required, STOP and report rather than migrate.
- Gates: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`. The admin reference UI is generic — if your changes alter what any existing admin/reference screen renders or any flow, run `npm run test:e2e` too and say so in the report (clear dev-DB fixtures after).
- Update `progress.md`'s Task 2 row in your final commit.

## Report

`docs/execution/2026-08-10-phase-6-quoting/task-02-report.md`: what you built, RED→GREEN narration for the default-normalization concurrency test specifically (name the guard you removed to see it red), how you represented `isDefault` in the grid/export/paste and why, every deviation, gate results with counts, E2E ran or why not. Commit it.
