# Phase 6 — Quoting — Execution Ledger

**Branch:** `phase-6-quoting` · **Spec:** `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` (approved 2026-08-10) · **Plan:** `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` (11 tasks)

Committed on the first task per the standing rule (the `.superpowers/sdd/` gitignore-clobber lesson —
git ignore rules only bite untracked paths, so committing early closes the exposure window).

## Design session (2026-08-10)

One-question-at-a-time owner brainstorm; fourteen rulings recorded in the spec's §3. The owner
supplied `docs/samples/Quote_Sample_Form.jpeg` mid-session (VS stock quote form — the PDF build
target) and approved the spec including the seven flagged precedent-based calls (notes pair;
close/reopen under `quotes.edit`; delete-with-reason + §5.14 block; immutable `customerId`;
empty linked quote = needs-price, never part-price fallback; contact delete not blocked;
no attachments this phase).

Code-hook verification done before the brainstorm: `quotes` area exists (`permission-constants.ts`),
`quote_number_next` already seeded in settings (consumed by nothing — Phase 6 only wires it),
NO Quote model / order column / auto-link exists anywhere (the kickoff's "order entry already
auto-links" was the spec's rule, not built code), tier-1's insertion point is the per-line
`PriceRowInput[]` assembly in `invoices.ts` (`listPartPrices` at ~line 401), `PriceSource` and
`DocumentKind` are both DB enums (⇒ two `ADD VALUE`s in one earlier migration directory).

## Task ledger

| Task | Status | Implementer | Review | Notes |
|---|---|---|---|---|
| 1. Schema, migrations, registrations | ✅ DONE | subagent (task-01) | ✅ Approved, Spec ✅ (task-reviewer, round 1 — zero Critical/Important) | Data layer + 2 hand-written migrations on both DBs + all registrations; gates green (126 files / 1952 tests). Reviewer verified the restated CHECK arm-by-arm, the enum split, and that both sweeps were strengthened. Two spec-text deviations for owner ratification (surfaced in controller summary): eachWeight mirrored at Part's real (10,4) — spec corrected in place; QuoteLine.partId blocker deferred to Task 7 (registry is structurally reference-kind-only). endingStatement pulled forward as bare BlockerTarget — Task 2 absorbs. Minor: no-RED-narration note (schema-only task, sanctioned) |
| 2. `endingStatement` reference kind | ✅ DONE | subagent (task-02) | ✅ Approved, Spec ✅ (task-reviewer, round 1 — zero Critical/Important; 4 Minor deferred to whole-branch triage: soft-deleted-row promote 200s silently (inherited generic-service hole, same as terms), a latent Serializable-snapshot precondition worth one comment sentence if a ref kind ever gains an FK column, §5.16 polish on the inactive-row Default checkbox, RED-window note matching the close-periods precedent) | Eleventh kind wired through the generic machinery (constants, EXTRA_SCHEMAS, new "boolean" extra-field kind for the grid/export/paste, picklist by derivation); Task 1's three temporary shims absorbed. At-most-one-live-default enforced in the service under `pg_advisory_xact_lock(4300, 0)` (predicate invariant — the period-lock precedent), demotions audited; concurrency test RED-verified (lock removed from the promote branch → two live defaults survive, competing caller pinned Read Committed). Gates green (126 files / 1967 tests, +15; tsc/eslint/build clean; E2E 18/18 — reference screen changed, fixtures cleaned) |
| 3. Quote service: create/read/list/worklist | ✅ DONE | subagent (task-03) | pending | `quotes.ts` (createQuote/getQuote/listQuotes/quoteWorklist/exportQuotes) + `quote-constants.ts`; tests 5 → 39 in quotes.test.ts. Part-prices mirrored (shared decimalField scales; `LOT_WITH_BREAKS` now exported from part-prices.ts and imported, not re-declared). RED-verified: the one-live-line-per-part payload dup (service check removed → the create LANDS both lines; the (quoteLineId, stepCode) partial unique never sees it) and the concurrent create (naive unguarded counter read + Read Committed → both read 1000, loser is a 400 the test refuses; restored → distinct consecutive numbers, losers clean 409s). §5.4 boundaries pinned: followUpDate ≤ today, expiryDate < today, both OPEN+live, one quote in both sections. Gates green (126 files / 2001 tests; tsc/eslint/build clean; E2E n/a — no UI/route). 10 documented deviations (report §Deviations) — notable: quotedQty×unlimited contradiction 400s, linked-part `active` NOT checked (brief says "live"), derived-filter complements avoid Prisma NOT over nullable followUpDate |
| 4. Quote service: update/close/delete + routes | — | | | |
| 5. Eligibility leaf + order auto-link | — | | | |
| 6. Tier-1 invoice substitution | — | | | |
| 7. Cross-entity §5.14 blocks | — | | | |
| 8. `/quotes` UI | — | | | |
| 9. Order entry / hub / part page surfaces | — | | | |
| 10. Quote PDF + print + `User.title` | — | | | |
| 11. E2E flow + docs + final gates | — | | | |
