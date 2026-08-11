# Task 7 brief — Cross-entity §5.14 blocks

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Depends on:** Tasks 1–6

**Binding documents (read in this order):**
1. `CLAUDE.md` + HANDOFF §5.14 (the blocked-delete-names-blockers rule and its registry/sweep machinery).
2. `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` — §7 third bullet, §4.2's Part/Customer rows.
3. `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` — Global Constraints + Task 7.
4. `docs/execution/2026-08-10-phase-6-quoting/task-01-report.md` — deviation 4: `QuoteLine.partId` was deliberately NOT FK-registered (the registry is structurally reference-kind-only); THIS task closes the gap on the parts side.

**Deliverable:** every delete path a quote can block now refuses-and-names, with tests. No new UI beyond what the existing blocker surfaces render automatically.

## What to build (plan Task 7)

1. **`deletePart`**: refuses when live quote lines reference the part, naming the quotes (quote numbers, linked to detail once Task 8's page exists — follow the existing blocker-list payload shape so the UI and Excel export render without special-casing). Read how deletePart's existing blocker list is built (shippers? orders? cert requirements?) and extend it consistently. The §5.14 Excel export of blockers must include the quote rows.
2. **`deleteReference("processStepCode")`**: Task 1 registered `QuotePrice.processStepCodeId` (`QUOTE_VIA_PRICE` — whole-chain liveness: price + line + quote all live). Verify the generic blocker walk actually surfaces quotes for a step code priced on a live quote, with a test; and that a DELETED quote's price rows do NOT block (the from-the-grave case Task 1's reviewer praised — pin it).
3. **`deleteReference("endingStatement")`**: blocked by live quotes referencing it, named. Test both directions (referenced → refused with names; unreferenced/dead-quote → deletes).
4. **`deleteCustomer`**: live quotes join its blocker list (alongside the existing children/orders checks). Test refusal naming quote numbers, and that a customer with only DELETED quotes still deletes (or is blocked by other rules — pin whichever the existing service does, consistently).
5. **Contact deletion is deliberately NOT blocked** (spec §4.1): confirm Task 3's blank-contact read test covers the surviving behavior; add one only if coverage is missing.
6. **Sweeps**: reference-links + permissions sweeps stay green; if the §5.14 registry sweep has a parts-side analogue, register there; if not, the deletePart blocker list IS the enforcement — say so in the report.

## Hard constraints

- Commands from `erp/`; conventional commits, no trailer; NO schema changes (STOP and report); don't touch `erp/.claude/`.
- Blocker messages/payloads match the established §5.14 contract exactly (names + links + Excel; 200-empty-workbook conventions where the precedent has them).
- Gates: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`. UI-visible behavior changes only through existing blocker surfaces — if any screen's rendering changes, run `npm run test:e2e` and say so.
- Update `progress.md`'s Task 7 row in your final commit.

## Report

`docs/execution/2026-08-10-phase-6-quoting/task-07-report.md`: each delete path's before/after behavior with citations; how the parts-side enforcement is guaranteed going forward (sweep or blocker-list-as-enforcement); deviations; gate results with counts; scrutiny pointers. Commit it.
