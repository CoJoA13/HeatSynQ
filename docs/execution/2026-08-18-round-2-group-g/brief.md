# Round 2 Group G — documents and templates — brief

Branch `group-g-documents`, opened 2026-08-18 from `848b5ae`. Issues: **#102, #103**.

## Kickoff rulings (2026-08-18)

- **#102 → close as not-reproducible-at-HEAD + fix the stale comment** (owner, asked at kickoff
  on the recon evidence below). No behavior change; the close comment records the findings, the
  legitimate-spill distinction, and the revisit trigger (anyone demonstrates a genuinely
  band-only trailing page).
- **#103 stays note-only** (the backlog's recorded scope — "read before evolving a template
  contract"). Recon confirmed neither alternative mechanism is small: graceful degrade requires
  restructuring the four-stage throw-fast battery (or silently discarding a customer's entire
  published customization — itself an owner-ruling-sized behavior change), and publishing-era
  contract validation requires versioning infrastructure. Not asked; nothing to ask.

## Recon findings the tasks are built on (verified 2026-08-18)

**#102 does not reproduce at HEAD.** Controller re-ran the recon's repro independently:

- n=30..70 for the canonical statement fixture: pass-1 probe, pass-2 layout, and real
  `renderPdf` page counts IDENTICAL at every n including the reported 40 and 61 (2pp for n≥33),
  every last page carrying body content.
- The only boundary behavior anywhere in n=1..160 × 12 geometry variants: at n=77/78 (2pp→3pp)
  and n=122/123/124 (3pp→4pp) pass 2's raised margin legitimately spills the final content
  block onto its own page — verified at n=77 the trailing page draws `Total Due: $30,800.00`
  plus the continuation band. Real content, never blank.
- A genuinely blank trailing page is structurally impossible for house builders: pdfmake
  creates a page only when an element fails to fit and that element is then PLACED on the new
  page (`pageElementWriter.js` `fitOnPage`), and header/footer callbacks draw onto
  already-existing pages only (`layoutBuilder.js` `addDynamicRepeatable` iterates a fixed
  `pages.length` after content layout) — a header cannot mint a page.
- Fix direction (a) from the issue (grow the margin only on overflowing pages) is inexpressible:
  pdfmake margins are document-level (`documentContext.js` `initializePage`), and
  `render-primitives.test.ts:252-262` pins the deliberate all-pages 40pt raise.
- Fix direction (b) (post-render trim) keyed on page growth would DELETE the Total Due line;
  keyed on the correct no-marks-outside-the-band predicate it is dead code on all evidence.
- `statement.ts` is unchanged since the Phase 7 merge (`56c9722`); `render.ts` touched since
  only by the Phase 8B watermark. The issue's n=40/61 most plausibly reflect a mid-task builder
  state or the reviewer's uncommitted sweep harness (task-13-report.md:105-118; the harness was
  never committed).

**#103's mechanism verified unchanged**, with ONE refinement over the issue text: not every
tightening is a 500. Shape tightenings (removed field key, narrowed enum) surface as `ZodError`
→ `handle()` maps to 400 (`http.ts:137-140`); rule tightenings (removable→false / new lock,
lowered `tableBudget`) throw `TemplateConfigError`, which no print-path site catches (the only
two catch sites are the editor save `templates.ts:294-299` and the preview
`template-preview.ts:127-132`) → 500. Either way old immutable published paper stops printing.
The §5.3 backfill fully covers additive loosening (pinned incl. two synthetic contract-growth
cases, `template-contracts.test.ts:116-190`). No test exercises publish-permissive → tighten →
print, and none is added (it would require building one of the out-of-scope mechanisms to go
green).

## Task 1 (the only implementation task) — record the truth in the three places it lives

Prose/comments ONLY. **The diff must contain zero executable-code changes** — the reviewer's
first check. All anchors verified at HEAD `848b5ae`.

1. **`erp/src/lib/template-contracts/types.ts` header** — extend the "THE §5.3 BACKFILL"
   paragraph (lines 20–24) with the #103 evolution warning. It must state, in the header's own
   voice: (a) the backfill makes additive LOOSENING safe — a new knob, field, or section, a
   widened enum, a raised budget, removable false→true — pinned by the synthetic contract-growth
   cases in `tests/template-contracts.test.ts`; (b) TIGHTENING any rule is NOT safe — a new lock
   or removable→false, a removed/renamed field key, a narrowed enum, a lowered `tableBudget` —
   because immutable PUBLISHED configs are re-validated at print-time dereference
   (`template-assignments.ts` `dereference` → `validateConfig`) with no catch on the print path,
   so previously-valid old paper stops printing: `TemplateConfigError` → 500 for rule
   tightenings, `ZodError` → 400 for shape tightenings; (c) the two sanctioned fix shapes if a
   tightening is ever genuinely required — validate a stored config against the contract version
   it was PUBLISHED under, or make print-time deref degrade gracefully (log + contract defaults
   for the offending elements) — citing #103. Fold naturally into the existing paragraph
   structure (the file already has the two-kinds-of-refusal paragraph directly above — don't
   duplicate it, reference it).
2. **`validateContractConfig` docblock** (types.ts lines 522–528) — one pointing sentence:
   called at print time on immutable published configs; before tightening any rule this battery
   enforces, read the evolution warning in this file's header (#103).
3. **`CLAUDE.md`** document-templates paragraph — fold the warning into the existing
   §5.3-backfill sentence (DISPLACE, don't append — the file's own curation rule): contracts
   evolve additively only; tightening a rule breaks print for immutable published configs; read
   the `template-contracts/types.ts` header first. One sentence's worth of growth, not a new
   block.
4. **`erp/tests/statement-templates.test.ts:341-343`** — correct the stale comment. It currently
   states the blank-page bug as fact ("~40, ~61 … spurious blank trailing page"). Replace with
   the truth: the verified boundary counts for this fixture are 77/78 and 122–124, where the
   raised margin legitimately spills the final Total Due block onto its own page (#102, closed
   not-reproducible); n=60 stays a clean mid-range fixture. Assertions unchanged.

DO NOT: add a note-text tripwire test (enforces prose, not behavior); add per-contract-file
header pointers (8 copies to drift; contract authors already read types.ts); add a standing
HANDOFF §5.x entry (HANDOFF brevity is an obligation — the close-out paragraph carries it);
touch `render.ts` or any builder.

## Gates

`npm test`, `npx tsc --noEmit`, `npx eslint src tests` — all from `erp/`. **E2E not required**:
the owner's E2E instruction covers changes touching "any UI, function, or flow" — this diff
touches comments and documentation only, which the reviewer confirms. If the diff turns out to
touch anything executable, E2E becomes mandatory again.

## Review

One task-reviewer pass over the whole diff: verify the diff is prose-only, and verify EVERY
factual claim in the new prose against the code at file:line (the 400-vs-500 split, the two
catch sites, the backfill test citations, the boundary counts and their spill behavior — the
reviewer may re-run the recon repro scripts from the scratchpad if needed).

## #102 close-out (controller, after this brief is committed)

Findings comment + close as not-planned (not-reproducible-at-HEAD), stating: the sweeps run and
their result, the structural impossibility argument, the legitimate-spill distinction (a
totals-only last page at a boundary count is correct output — do not re-report it as "blank"),
the inexpressibility of fix (a) and the content-deleting hazard of naive fix (b), and the
revisit trigger. The stale-comment correction rides the Group G PR (Closes #103 only — #102 is
closed manually since the PR contains no fix for it).
