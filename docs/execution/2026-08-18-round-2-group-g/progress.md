# Round 2 Group G — documents and templates — progress ledger

Branch `group-g-documents`, opened 2026-08-18 from `848b5ae`.
Issues: **#103** builds (note-only, per the backlog's recorded scope); **#102 closed
not-reproducible-at-HEAD at kickoff** (owner ruling on the recon evidence — see brief).

## Kickoff (2026-08-18)

- Recon: three parallel agents (root-cause + repro, blast radius, #103 verification).
  Headline: #102's blank trailing page does not reproduce at HEAD — controller re-verified the
  sweep independently before taking the ruling (n=30..70 identical page counts incl. the
  reported 40/61; the only boundary behavior is legitimate Total-Due spill at 77/78 and
  122–124). Full evidence in the brief; findings + revisit trigger recorded on the closed
  issue.
- Owner ruling: **#102 → close + fix the stale test comment** (recommended option taken).

## Task verdicts

**Task 1 (#103 notes + #102 comment correction, prose-only)** — implementer
`954c5a1`/`494b4d3`. Review: **Spec ✅ · Approved (round 1)**, zero fixes. The reviewer
verified every hunk is comment/markdown (zero executable-code changes), line-by-line verified
every factual claim in the new prose against HEAD (the uncaught print-path deref with exactly
two editor-side catch sites; the TemplateConfigError→500 / ZodError→400 split per tightening
kind; the synthetic contract-growth pins; the tightening→error-class mapping through
`assertLocksHonored`/`assertWidthBudgets`/the `.strict()` schemas; the 77/78 + 122–124
boundary counts), and confirmed placement/voice (98-col header extension referencing — not
duplicating — the two-kinds paragraph; CLAUDE.md displaced not appended). One minor
(the "pinned by the synthetic cases" claim read wider than the two cases pin) —
**controller-applied on-branch** (`c1d66c0`).

## Group tally

One implementation task, one review — **Approved on round 1, zero implementer fix rounds**
(one controller-applied wording minor). One issue closed without code at kickoff (#102,
not-reproducible, owner ruling). No schema migration; no executable-code change anywhere in
the group.

## Codex rounds (PR #151, 2026-08-18)

Two P2s across two rounds, both wording-precision findings on the new warning paragraph, both
**verified real and accepted**:

- **Round 1** (`2629207`): "a new field is safe" over-claimed — a new COLUMN field backfills
  `visible: true, width: null`, so `assertWidthBudgets` counts its `defaultWidth` against the
  table total, and a published config already near `tableBudget` would hit the width refusal
  at print. Amended with the exactly-sufficient rule: a backfilled column contributes exactly
  `defaultWidth`, so a column addition must raise its table's budget by at least that amount
  in the same change (`"*"` counts 0).
- **Round 2** (`bcdfaf7`): "tightening breaks paper the shop has already published"
  over-claimed the other direction — a tightening breaks only configs whose STORED values
  violate the new rule. Amended with the precise split: effectively categorical for a
  removed/renamed key (saves store the complete validated parse, `templates.ts:303-306`),
  conditional for locks/budgets/enums; and the repo alone cannot prove none is affected since
  published versions live only in each deployed database. CLAUDE.md's pointer sentence
  matched. The same push corrects two controller-found imprecisions from round 1's own text
  (an inverted predates-clause; the saved-before-the-key-existed edge).

Replied + resolved per the loop both rounds.

## Gates (final tree `c1d66c0`, 2026-08-18; Codex amendment `2629207` is prose-only in the same file)

| Gate | Result |
|---|---|
| `npm test` | **3260 passed / 191 files** (unchanged — prose-only diff) |
| `npx tsc --noEmit` | clean (re-verified by the reviewer) |
| `npx eslint src tests` | clean |
| `npm run test:e2e` | **not run — brief ruling**: the diff touches no UI, function, or flow (comments + markdown only; reviewer-verified) |
