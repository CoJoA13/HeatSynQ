# Phase 7 — Template Designer (full narrative)

**Merged to `main` as `56c9722` (PR #104, squash, 2026-08-14).** This file is the phase's full
record, moved out of `docs/HANDOFF.md` §4 when the phase closed; §4 keeps one paragraph and points
here. The per-task account — every brief, implementer report, reviewer verdict, and the progress
ledger — lives in `docs/execution/2026-08-12-phase-7-template-designer/`. The approved design spec is
`docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md`; the plan is
`docs/superpowers/plans/2026-08-12-phase-7-template-designer.md`.

## What it delivered

Spec §8 in full: the eight document types (traveler, shipper, MOS shipper, BOL, cert,
invoice/credit, statement, quote) became **data-driven templates** — multiple per type, one default,
per-customer assignment resolved division → nearest ancestor → type-default, **draft → publish
versioning** with immutable published versions, and a structured, contract-driven visual editor
(logo upload/placement, section show/hide+reorder, field add/remove/reorder, label overrides, number
/date/width/font knobs, standing-text blocks) with **live preview against a real record**. The
roadmap's testable outcome — *the owner restyles the traveler/logo, publishes, prints, and the paper
shows it* — is proven end-to-end against the archived PDF bytes (`tests/traveler-restyle.test.ts`).

## The design session (2026-08-12) — seven owner rulings

The owner chose Phase 7 over Phase 8 / parallel-run prep / backlog burn-down, then ruled: (1) all
eight types at full depth in one phase; (2) draft → publish versioning; (3) all four format knobs
(labels, number formats, date formats, column widths); (4) `Part.processName` fills the traveler's
Process: slot and the invoice's create-time snapshot; (5) a curated bundled font set, no upload;
(6) fold-ins #36/#43/#97/#98/#87 ride along (#85/#52 stay in the backlog); (7) division inherits the
parent's assignment. The draft spec was adversarially reviewed on four lenses before approval — the
findings it caught before a line of code shipped: a never-published-template resolution hole, an
honest "immutability, not locking" argument for the publish-vs-print race (a print reads the last
published pointer without claiming the template row — safe because published versions are immutable),
discard-as-status-flip instead of a hard delete, config diffs kept in the audit trail, and the
`pdf-lib` dependency surfaced for the owner's explicit sign-off (approved).

## Execution — 21 tasks, every one approved on review round 1

Fresh subagent per task → an independent task-review (spec compliance + quality) → the verdict
recorded. The shape:

- **Infrastructure (1–6):** the typed per-docType template contract as the single source of truth
  (sections/fields/locks/text-blocks/format-knobs + `DEFAULT_CONFIG` with the §5.3 absent-key
  backfill); `DocumentTemplate`/`DocumentTemplateVersion`/`CustomerTemplateAssignment` (3 hand-written
  migrations, both DBs; the "Standard" seed COALESCE-copying the live standing-text Settings into the
  seeded configs); the draft→publish service (claim-guarded publish/set-default/reasoned-delete, the
  `updatedAt`-precondition draft edit, all four concurrency guards RED-verified); the walk-to-root
  assignment resolution; the render runtime — declarative `pageFooterSpec`/`continuationHeaderSpec` +
  per-sheet-group rendering via `pdf-lib` (confined to `render.ts`), the 4-family vendored font set
  (Roboto + Liberation Sans/Serif + Roboto Mono, SIL-OFL, sha256-provenanced, standalone-trace
  verified).
- **The eight conversions (7–14):** every builder became a config-consumer under a golden gate (the
  seeded Standard template reproduces today's paper — the builder's own pdf test unedited); each
  carried its own trap (the ticket's two-date-styles split, the invoice's frozen-paper invariant, the
  quote's two-money-precisions knob) and closed its fold-in. Task 14 (quote, last) retired the four
  standing-text Settings into template text blocks (`20260813120000_retire_standing_text_settings`
  deletes the orphaned rows; nothing stranded — the values were seed-copied at Task 3).
- **The UI stretch (15–21):** the `Part.processName` field; the templates admin list + nav (Option B
  — an admin-group entry gated on `templates.view` specifically, so a `templates.view`-only user
  reaches it without seeing the rest of Admin); the contract-driven editor + logo panel; the §5.13
  save/conflict UX (reload-vs-overwrite, banner-ordering preserved); the side-effect-free preview;
  the customer-page assignment picker (the resolution walk extracted into one shared
  `resolveAssignment` that print and picker both call, so they can never diverge — parity-tested);
  and Task 21's restyle proof + docs pass.

## Bugs caught along the way — the review layers earning their keep

- **A pre-existing StrictMode stale-response defect** (found during Task 7's E2E): `QuoteDetail`'s
  load effect had no stale gate, so the dev double-mount's late GET re-adopted pre-edit server state
  over an in-progress draft, silently wiping edits. Root-caused deterministically (2/2 → 0/2), fixed
  with the house stale-gate idiom. This superseded Task 6's "compile-pause flake" hypothesis for the
  quotes E2E.
- **Two latent bugs in the shared PDF test-decoder `tests/helpers/pdf.ts`** — the golden-test oracle
  every conversion leans on: a dropped ligature-CMap destination (Task 8, shifted every later glyph)
  and a `/Length` truncation (surfaced when a Task-14 quote test had been *silently red since its
  approval* because its gate number was never independently re-run — the Task 14 lesson). Product code
  was never wrong; the oracle is now hardened, and the incident is why the controller re-runs gates.

## The review finale — whole-branch, then Codex

- **Whole-branch review:** a 5-dimension adversarial workflow (concurrency/data-integrity,
  golden-compat/decoder-oracle, client-server/permissions, cross-task consistency/spec, fresh-eyes),
  each finding verified. CLEAN on concurrency/data-integrity, **zero BLOCKER/MAJOR**; one confirmed
  MINOR (a stale settings comment) fixed; three raw findings refuted to NON-ISSUE (one filed as the
  forward-hazard #103).
- **Codex PR review found three real correctness bugs** — and one, a **P1**, the whole-branch review
  had **missed**: `assignTemplate` ran Read Committed with an unpaired customer-liveness read, so a
  concurrent `deleteCustomer` could strand a live assignment on a soft-deleted customer (invisible on
  the customer page, blocking that template's §5.14 deletion forever). Fixed by making it Serializable
  with the customer read inside the tx — the exact `createPart↔deleteCustomer` SSI precedent;
  RED-verified. The other two were UI stale-state bugs (an editor not keyed by id — §5.12; a
  template-detail fetch not stale-gated — §5.13, the same class as the quotes bug above). All three
  fixed on-branch, controller-confirmed. **The lesson recorded:** no single review layer is
  sufficient; the per-task → whole-branch → automated-PR-review stack is what caught the P1.

## Final gates (at merge)

2744 tests / 149 files; `tsc`/`eslint`/`build` clean; E2E **20/20**; **35 migrations** clean on both
DBs. Fold-ins **#36/#43/#87/#97/#98** closed via the PR body. Deferred, filed, non-blocking: **#102**
(render two-pass leaves a spurious blank trailing page at boundary overflow counts — cosmetic,
affects every overflow-capable document, wants a dedicated render pass with byte-golden re-baselining)
and **#103** (a future contract-rule *tightening* could 500 an old immutable published config at print
— version the contract or degrade gracefully when it's picked up).

## Standing conventions this phase added to CLAUDE.md

Template contracts as the single source of truth (+ locked elements §5.6 + the §5.3 `DEFAULT_CONFIG`
backfill/three-copies drift guard); publish-by-immutability (prints resolve the last published
version, correct at any isolation **without** locking the template row); `pdf-lib` confined to
`render.ts`; the four retired standing-text Settings keys now living in template content.

## Carried notes for whoever touches this next

- One shared `resolveAssignment` drives **both** the print path and the customer picker — any edit to
  it moves what real orders print; the parity test is the guard, keep it.
- `tests/helpers/pdf.ts` has now had two real bugs; its non-greedy EOL-strip fallback is now dormant
  (both PDF writers emit a direct `/Length`) — not covered by any production render.
- Owner still owes the shop **logo file** (`docs/samples/`, PNG/JPEG) for the demo; the E2E uses a
  fixture logo until then.
- Pre-existing E2E-infra flake (NOT a Phase 7 defect): `close-month-end` intermittently hangs under
  full-suite load; a killed run strands a `ClosePeriod`+GL chain that cascades into A/R-flow failures
  — clean `GlPosting`→`GlExportBatch`→`ClosePeriod` in FK order before re-running.
