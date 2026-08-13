# Task 1 brief — Schema, migrations, and every registration that keeps the gates green

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` (you are already on it) · **Date:** 2026-08-10

**Binding documents (read in this order):**
1. `CLAUDE.md` — house rules, especially "Constraints that will bite you" (TTY-less migrations, two databases, StoredDocument CHECK convention, partial-unique rules).
2. `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` — §4 (data model) is your contract; §3 rulings 1–14 give the why; §9 the migration shape.
3. `docs/superpowers/plans/2026-08-10-phase-6-quoting.md` — "Global Constraints" + "Task 1" are your steps.

**Deliverable:** the complete Phase 6 data layer and every registration required to keep ALL gates green, committed as one or more conventional commits (NO attribution trailer). No service logic, no routes, no UI — later tasks own those.

## What to build (spec §4.1–§4.2, plan Task 1)

1. **`prisma/schema.prisma`:** models `Quote`, `QuoteLine`, `QuotePrice`, `QuotePriceBreak`, `EndingStatement` exactly per spec §4.1 (carry the load-bearing rules as schema comments: allocation-only `quoteNumber`; XOR line identity; no GL on quote rows; judged-at-link-time link). Columns on existing models: `OrderLine.quoteLineId String?` (+ relation + index), `InvoiceLine.sourceQuoteNumber Int?` (frozen snapshot — comment it), `User.title String @default("")`, `StoredDocument.quoteId String?` (+ relation + index; update the kind→owner comment block). Enum additions: `DocumentKind.QUOTE`, `PriceSource.QUOTE`. All back-relations (`Customer.quotes`, `Part.quoteLines`, `ProcessStepCode.quotePrices`, `CustomerContact`, `User` — quotedBy and closedBy need NAMED relations, `EndingStatement.quotes`).
2. **Two migration directories**, hand-written via the TTY-less workflow (`/create-migration` skill or `migrate diff` + hand-written SQL — `npx prisma migrate dev` WILL refuse):
   - `<ts>_quote_enum_values/` — ONLY the two `ALTER TYPE … ADD VALUE 'QUOTE'` statements (DocumentKind, PriceSource). Own directory because Postgres refuses to use a new enum value in the transaction that added it and `migrate deploy` runs one directory per transaction.
   - `<ts>_quoting/` — tables, columns, indexes; partial uniques `QuotePrice(quoteLineId, processStepCodeId) WHERE "deletedAt" IS NULL` and `EndingStatement(name) WHERE "deletedAt" IS NULL` (schema side: `@@unique([...], where: raw("\"deletedAt\" IS NULL"))`); and `StoredDocument_kind_owner_check` DROPped and re-ADDed **restated whole** — read the current definition in `prisma/migrations/20260808230100_accounts_receivable/migration.sql` first; the new arm is `QUOTE ⇒ "quoteId" NOT NULL` with every other owner column null, and EVERY existing arm additionally asserts `"quoteId" IS NULL`.
   - Apply to BOTH databases (`npx prisma migrate deploy`, then again with `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test"`), then `npx prisma generate`. Verify `npx prisma migrate status` clean on both.
3. **Registrations:**
   - `src/server/audit.ts`: `Quote` (and its children if the existing pattern registers children separately — follow the Order/Invoice precedent) join `AuditableModel`; `SNAPSHOT_INCLUDE` for Quote pulls `lines { include: { prices: { include: { breaks } } } }`-shaped relations, matching the existing include style.
   - `src/server/settings.ts`: `quote_valid_days` (int schema like the numbering seeds but its own validation — positive int, default 30, group per existing date-defaults group), `quote_intro_text` (string, default "We are pleased to provide you with the following quotation:", group with the other document text blocks), `quote_liability_text` (string, default ""). `quote_number_next` ALREADY EXISTS — do not re-add.
   - `src/lib/invoice-constants.ts`: `PRICE_SOURCES` gains `"QUOTE"` + label.
   - `src/server/documents.ts`: `AREA_FOR_KIND.QUOTE = "quotes"`; extend `DocumentOwner` and `ownerColumns` with the QUOTE arm (tsc forces this once the enum gains the value).
   - FK/blocker registries (`src/lib/reference-links.ts` and whatever the sweep tests demand): entries for `QuotePrice.processStepCodeId`, `Quote.endingStatementId`, `QuoteLine.partId`. Registration ONLY — behavioral blocker messages are Task 7. Run the sweep tests and satisfy exactly what they enforce; if a registration structurally requires the Task 2 reference-kind wiring, pull forward the minimal constants entry and note it in your report.
   - `tests/partial-unique-sweep.test.ts`: documented exemption for `Quote.quoteNumber` (allocation-only — a deleted quote keeps its number forever; the `Order.orderNumber` precedent, same comment style).
4. **Tests (TDD where there is behavior; smoke where there is only schema):** a smoke test in a new `tests/quotes.test.ts` creating a Quote+line+price+break via raw prisma and reading it back (full service TDD is Task 3); all sweep tests green; the full suite green.

## Hard constraints

- Work from `erp/` for all commands. Do not touch `erp/.claude/` (untracked, unrelated).
- Schema comment style: match the existing schema's `///` comments.
- Migration SQL: read your `migrate diff` output IN FULL before shipping it; hand-adjust to the two-directory split; never ship SQL you have not read.
- Decimal scales: prices `Decimal(12, 4)` for unit/break price, `Decimal(12, 2)` for setup/minimum/threshold/eachWeight per spec §4.1 (eachWeight is `Decimal(12, 4)` — match `Part.eachWeight`'s actual scale; CHECK the Part model and mirror it; note what you found in your report).
- Gates before you claim done: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`. (No UI/flow change here, so E2E is not required for this task.)
- Commit(s): conventional, no trailer. Update `docs/execution/2026-08-10-phase-6-quoting/progress.md`'s Task 1 row (status + one-line note) in your final commit.

## Report

Write `docs/execution/2026-08-10-phase-6-quoting/task-01-report.md`: what you built, every deviation from this brief and why, the eachWeight-scale finding, what the sweeps demanded for the FK registrations, gate results (exact counts), and anything the reviewer should scrutinize. Commit it.
