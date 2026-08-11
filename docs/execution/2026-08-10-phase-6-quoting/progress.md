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
| 1. Schema, migrations, registrations | — | | | |
| 2. `endingStatement` reference kind | — | | | |
| 3. Quote service: create/read/list/worklist | — | | | |
| 4. Quote service: update/close/delete + routes | — | | | |
| 5. Eligibility leaf + order auto-link | — | | | |
| 6. Tier-1 invoice substitution | — | | | |
| 7. Cross-entity §5.14 blocks | — | | | |
| 8. `/quotes` UI | — | | | |
| 9. Order entry / hub / part page surfaces | — | | | |
| 10. Quote PDF + print + `User.title` | — | | | |
| 11. E2E flow + docs + final gates | — | | | |
