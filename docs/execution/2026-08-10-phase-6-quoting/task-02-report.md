# Task 2 report — The `endingStatement` reference kind (spec ruling 13)

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-10 · **Implementer:** Task 2 subagent

## What was built

**Commit 1 — kind wiring (`c31f3a2`).** `endingStatement` appended to `REFERENCE_KINDS` (the
eleventh kind); `REFERENCE_LABELS` entry ("Ending statement" / "Ending statements" / "Name");
`EXTRA_SCHEMAS.endingStatement` = `text` max 4000 optional (the `commentSnippet.text` precedent,
verbatim shape) + `isDefault` boolean optional; `REFERENCE_EXTRA_FIELDS.endingStatement` =
`text` (kind `"text"`) + `isDefault` (new kind `"boolean"`, label "Default", hint "setting it
clears the current default"). `PICKLIST_KINDS` picks the kind up **by derivation** (it is
`REFERENCE_KINDS` minus `glAccount` plus `processStepCode`) — no edit needed, and the
glAccount exclusion is untouched; `listPickList`'s generic delegate branch serves it (id/name/
active only — `text`/`isDefault` never cross the session-only route; quote entry's default
resolution is server-side, Task 3). Task 1's three temporary shims absorbed: the bare
`BlockerTarget` literal is gone (the union reaches `endingStatement` through `ReferenceKind`
now), its `TARGET_LABELS` row deleted (record type narrowed back to
`"processStepCode" | "surcharge"`), and the sweep's `kinds.add("endingStatement")` + the local
target-kind-set literal removed. Enforcement is equal-or-stronger: the same sweep still surfaces
`quote.endingStatementId -> endingStatement` (pinned list unchanged), `findBlockers`/
`assertRefExists` reach it as before, and the kind additionally gains the generic reference
delete guard, admin CRUD, and the delegate-contract test (`reference-gl.test.ts` runs every
member of `REFERENCE_KINDS`).

**Commit 2 — default normalization (`f5fbf0c`).** Service-enforced in `reference.ts` (§5.17 —
no route or future caller can bypass it), the customer-address default precedent with one
deliberate difference: **no auto-promotion** (addresses require a default per kind; a
defaultless ending-statement kind is legal — `Quote.endingStatementId` is nullable, spec §4.1).

- A create or update setting `isDefault: true` demotes every other live default **inside the
  same transaction**, each demotion an `auditedUpdate` (the customer-address `setDefault`
  lesson: a bare update leaves the demoted row's history claiming `isDefault: true` forever).
- Deactivation (`active: false`) strips the flag in the same write — the kind goes defaultless,
  and a later reactivation cannot silently resurrect a default beside a newer one.
- An inactive row cannot be flagged: `{active: false, isDefault: true}` on create or update, or
  promoting a stored-inactive row, is a 400 ("An inactive ending statement cannot be the
  default") — rejected rather than silently stripped, because the caller asked for a
  contradiction. (The address precedent normalizes silently, but it does so as part of an
  after-every-write normalizer it needs anyway for auto-promotion; here an explicit refusal is
  the smaller and clearer behavior.)
- Deleting the default leaves the kind defaultless; the soft-deleted row keeps its flag bits in
  the grave (every live-default read filters `deletedAt: null`, and there is no
  revival-on-create) — deliberately no extra hook in `deleteReference`.
- Explicitly clearing (`isDefault: false`) is unguarded — it can only shrink the default set.

**Concurrency.** "At most one live default" is a predicate over the whole table — a kind with
zero defaults has NO row expressing the state — so, exactly like the period lock, no
`SELECT … FOR UPDATE` can claim it: two make-me-default writes promoting different rows may
share no row at all. Every default-**adding** write (and the deactivation strip, closing the
promote-vs-deactivate race on one row) therefore takes `pg_advisory_xact_lock(4300, 0)` first
(`period-locks.ts`'s two-int namespacing precedent; 4200 is taken), and the promote branch
re-reads the row's `active` **under** the lock. The demote-scan then always runs after any
competing writer committed, at ANY caller isolation.

**Commit 3 — grid/export/paste (`5b52a44`).** How `isDefault` is represented, and why:

- **Grid rows:** an interactive checkbox, gated `admin.edit` — the Active toggle is the one
  boolean the grid already renders, so the new `"boolean"` extra-field kind copies it exactly
  (`toggleActive` generalized to `toggleFlag(row, key)`, one PUT-a-flag helper for both).
  This is also what makes an existing row **promotable** at all: the generic grid has no
  row-edit affordance for extra columns (comment snippets' text is add-time-only today), so
  without the interactive cell the only way to move the default would be creating a new row.
- **Add row:** a plain checkbox; `draft` is a string map, so it round-trips `"true"`/`""` and
  `buildPayload()` converts — checked → real `true`, unchecked → key dropped (column default).
- **Export:** the raw boolean passes through untouched — a TRUE/FALSE cell, exactly how the
  Active column has always exported. No route change; the test pins the cell shape.
- **Paste:** `paste.ts` coerces a case-insensitive `"true"`/`"false"` cell to a real boolean
  (Excel renders — and a copy therefore delivers — TRUE/FALSE); anything else stays a string so
  zod's own "expected boolean" names the bad cell per-row (the `numberColumns` philosophy).
  Blank cells were already dropped by the existing optional-cell filter.

## RED→GREEN narration — the default-normalization concurrency test

The test (`reference-tables.test.ts`, "two concurrent make-me-default writes end with exactly
ONE live default") hand-scripts the competing caller as a HOLDER transaction **pinned to Read
Committed** (`isolationLevel: ReadCommitted`, explicit) that performs the same critical section
the service performs — takes `pg_advisory_xact_lock(4300, 0)`, scans live defaults (finds
none), writes `isDefault: true` on row A — then holds it all **uncommitted** while the REAL
`updateReference("endingStatement", b.id, { isDefault: true })` races it; only after 200 ms is
the holder released (the close-periods holder/competitor shape).

**The guard I removed to see it red: the `await lockEndingStatementDefault(tx)` call in the
promote branch of `normalizeEndingStatementDefaultOnUpdate`.** With it gone, the competitor
never blocks: its demote-scan runs while the holder's flag write is uncommitted (invisible at
Read Committed), finds nothing to demote, flags B and commits; the holder then commits A —
**two live defaults**, and the test failed on exactly that assertion (the failure output showed
both ids in the live-defaults list). Restored, the competitor queues on the advisory lock until
the holder commits, its scan then sees A's committed flag and demotes it (audited), and the
test passes: exactly one live default, and it is the later writer. Deterministic in both
directions — the barriers fix the interleaving; no retry-loop probabilism.

## Tests added/changed

- `tests/reference-tables.test.ts` — kind-list pin gains `endingStatement` (sorted position);
  text-body + default-flag round-trip; >4000-char text rejected; `KINDS_WITH_EXTRAS` gains the
  kind (re-created name carries no predecessor extras); new describe (9 tests): create-demotes
  (with the demotion's own audit entry asserted before/after), update-promotes, explicit-clear
  → defaultless, deactivate-strips + reactivation-does-not-resurrect, inactive-cannot-be-default
  ×3 forms, delete → defaultless, paste round-trip through the service normalization, bad
  boolean cell per-row report, and the RED-verified concurrency test.
- `tests/picklists.test.ts` — the kind served to a session with zero permissions, projection
  pinned to id/name/active (no `text`/`isDefault` leak); the existing glAccount-404 test still
  covers the exclusion.
- `tests/excel.test.ts` — endingStatement export: header row [Name, Text, Default, Active] and
  a real boolean cell.
- `tests/reference-links-sweep.test.ts` — the two temporary `endingStatement` literals removed;
  everything else unchanged (the pinned FK list still names `quote.endingStatementId`).
- Auto-coverage inherited by membership: the delegate-contract round-trip and the
  create/duplicate loops in `reference-gl.test.ts`/`reference-tables.test.ts` now run over the
  new kind.

## Deviations

1. **The `"boolean"` extra-field kind is interactive on existing rows** (a checkbox that PUTs,
   like Active) rather than display-only. The brief left the boolean representation to me
   ("minimal choice, document it"); display-only would have been smaller but would leave no way
   to promote an existing statement (the generic grid has no extra-column row editing), making
   the one-default feature unusable after initial entry. The Active toggle is the in-grid
   precedent copied.
2. **Inactive-cannot-be-default is a 400, not a silent strip** — the address normalizer's
   silent version exists to serve auto-promotion, which this kind deliberately lacks; an
   explicit contradiction gets an explicit refusal. Deactivating the current default IS
   silently stripped (that one is not a contradiction — it is the documented defaultless
   transition).
3. **`deleteReference` gets no endingStatement hook** — the address precedent quietly clears
   the flag on soft-deleted rows; here the dead row keeps it. Every live-default read filters
   `deletedAt: null` (house rule, sweep-enforced for the unique column and universal in this
   codebase), so the stale bit is unreachable; the delete's own audit snapshot records the flag
   honestly.
4. **The advisory lock also guards the deactivation strip** (not just promotes) — one step past
   the brief's minimum, closing the promote-vs-deactivate race on the same row that would
   otherwise leave an inactive row flagged (promote's pre-lock `active` read racing a
   concurrent deactivate). The promote branch's `active` re-read happens under the lock for the
   same reason.
5. **Paste boolean coercion accepts only `true`/`false` (case-insensitive)** — not yes/no/1/0.
   Excel's clipboard produces TRUE/FALSE for boolean cells (what our own export emits), and
   anything else failing loudly through zod beats guessing.

## Gate results

| Gate | Result |
|---|---|
| `npm test` | **126 files passed, 1967 tests passed, 0 failed** (was 126 / 1952 after Task 1; +15) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | ✓ Compiled successfully; 71/71 static pages generated |
| `npm run test:e2e` | **18/18 flows passed** (template-build-and-load through close-month-end); "Cleaning up dev-DB fixtures (erp)… cleanup ok" — fixtures cleared by the harness teardown |

E2E was required and run: the admin reference screen changed (a new "Ending statements" tab in
the generic kind list, plus the `toggleFlag` refactor every existing tab's Active checkbox now
routes through). No flow drives the reference grid directly, but permission-gating and the admin
shell render around it, and the standing owner instruction (2026-08-06) makes the run mandatory
for any UI-touching change regardless.

## For the reviewer to scrutinize

- The absorption completeness: `git grep endingStatement src/lib/reference-links.ts` should show
  only the doc-comment history note and the registry entry — no bare-target machinery left.
- Deviations 1–4 above — each a judgment call the brief delegated.
- The advisory-lock scoping in `normalizeEndingStatementDefaultOnUpdate`: the explicit-clear
  path deliberately takes no lock (shrink-only); confirm no path that can ADD a flag escapes it.
- The concurrency test's holder mimics the service's critical section by hand — if the service's
  locked section ever changes shape, the holder must change with it (same standing caveat as the
  close-periods holder tests).
