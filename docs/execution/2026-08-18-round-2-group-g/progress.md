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

- **Round 3** (two P2s, both real): the round-1 budget-raise remedy was bad guidance (raising
  `tableBudget` past the physical width only disables the overflow guard — it cannot widen the
  paper), and a new NON-removable field inside a hideable section is a tightening in disguise
  (`assertLocksHonored` refuses a stored config that legally hid the section). Third
  consecutive round on the same mechanism → **lesson 4 applied: fixpoint, not another patch.**
  The paragraph was rewritten criterion-first — "additive" is a SEMANTIC test (every config
  valid under the old contract stays valid, and stays on the paper, under the new one) — with
  the safe/unsafe enumeration demoted to examples of the criterion, the additive-looking traps
  named (visible column on an existing table; non-removable field in a hideable section; plus
  newly-pinning a section, controller-added), and the budget-raise remedy replaced by the
  physical-headroom truth. CLAUDE.md's pointer sentence re-matched.

- **Round 4** (two P2s): the criterion itself was one notch weak — a changed `defaultLabel`/
  `defaultWidth` keeps every stored config VALID yet silently rewrites the next print of
  already-published versions (stored `null`s resolve `?? default` against the CURRENT contract
  — verified in `traveler.ts` and the width check — breaking the §5.3 identical-render promise;
  a raised `defaultWidth` can also trip the width refusal). Criterion strengthened to "stays
  valid AND keeps rendering the same paper", default changes added to the traps, the sanctioned
  publishing-era shape re-stated as "validate AND resolve" (defaults preserved too). Second P2
  half-verified: the per-division statement print catches per member and 200s with per-member
  failures (`statements.ts:485-513`) — the raw 500/400 claim is now scoped to single-document
  routes; its cert-bundle example did NOT verify (`printCert` has one call site, the uncaught
  single-document route) and was not adopted.

- **Round 5** (one P2, real): the SAFE list contradicted the strengthened criterion — a new
  knob is only "same paper" when it defaults to the prior hardcoded behavior (the §5.3
  DEFAULT_CONFIG convention), and a new field/section backfills VISIBLE, landing on every
  stored config's next print. The safe list now carries the rendering-neutrality proviso, and
  the synthetic-cases citation is scoped to what those tests actually pin (parsing and default
  insertion, not output).

Replied + resolved per the loop, all rounds. Standing note: if a round 6 brings further
prose-nuance findings, the stop-reviewing ruling applies — triage to the ledger/issue rather
than another push cycle (correctness-of-fact findings excepted).

## Gates (final tree `c1d66c0`, 2026-08-18; Codex amendment `2629207` is prose-only in the same file)

| Gate | Result |
|---|---|
| `npm test` | **3260 passed / 191 files** (unchanged — prose-only diff) |
| `npx tsc --noEmit` | clean (re-verified by the reviewer) |
| `npx eslint src tests` | clean |
| `npm run test:e2e` | **not run — brief ruling**: the diff touches no UI, function, or flow (comments + markdown only; reviewer-verified) |
