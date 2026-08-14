# Task 3 brief — Schema, migrations, seeds, and registrations

**Branch:** `phase-7-template-designer` (Tasks 1–2 APPROVED; all eight contracts + `DEFAULT_CONFIG`s exist in `erp/src/lib/template-contracts/`; suite at 2226).
**Read first:** `CLAUDE.md` — especially "Schema changes apply to two databases", the TTY-less migration workflow, the audit-layer section, and §5.11's partial-unique rules; the spec `docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md` **§4 (the whole data model) + §9 (migrations)**; the plan Task 3 + Global Constraints; **Task 2's report** (its Task 3 notes: the quote's `pageFooter: true` seed literal, `quote_liability_text`'s deliberately-EMPTY default — the Setting-copy fallback must produce `""`, not omit the key — the liability text's real `\n\n`, the aging en-dash "1–30" in SQL encoding); the ledger's carried-minors section — **two are routed to you as pre-steps**.

## Pre-steps (BEFORE the seed literals freeze — carried from Task 2's review)

1. Rename the date-format token `"MMM D, YYYY"` → `"MMMM D, YYYY"` across `types.ts`, the invoice/statement contracts, and their tests (it is bound to the FULL-month `longDate` — "July 29, 2026"; nothing is stored anywhere yet, so the rename is free now and a trap later).
2. The invoice contract's `quote_source` defaultLabel: reference `PRICE_SOURCE_LABELS.QUOTE` from `src/lib/invoice-constants.ts` (client-safe) instead of duplicating the string.

## Deliverable

1. **Schema** (`erp/prisma/schema.prisma`), exactly per spec §4.1/§4.2:
   - `TemplateDocType` enum: `TRAVELER, SHIPPER, MOS_SHIPPER, BOL, CERT, INVOICE, STATEMENT, QUOTE`.
   - `DocumentTemplate`: `docType`, `name`, partial-unique `@@unique([docType, name], where: raw("\"deletedAt\" IS NULL"))`, `isDefault Boolean @default(false)`, `publishedVersionId String?` → `DocumentTemplateVersion` (comment: null only between create and first publish; a never-published template can be neither default nor assigned — service-enforced in Task 4), `deletedAt`, timestamps, relations.
   - `DocumentTemplateVersion`: `templateId`, `versionNumber Int` + `@@unique([templateId, versionNumber])`, `status String` (comment: `DRAFT → PUBLISHED | DISCARDED`; published rows immutable; discard is a status flip — NO deletedAt, NO delete path, deliberately), `config Json`, `logoImage Bytes?`, `logoMimeType String?`, `publishedAt DateTime?`, `publishedById String?` → User, timestamps.
   - `CustomerTemplateAssignment`: `customerId`, `docType`, `templateId`, `deletedAt`, timestamps, `@@unique([customerId, docType], where: raw("\"deletedAt\" IS NULL"))`, indexes.
   - `Part.processName String @default("")` (comment: presentation vocabulary — prints on the traveler Process: slot and folds into the invoice's create-time `processNames` snapshot; ruling 4).
   - `StoredDocument.templateVersionId String?` → `DocumentTemplateVersion` + index. **The kind→owner CHECK is deliberately untouched — write the schema comment saying why** (its arms govern the six owner FKs; this column is render metadata present on every kind).
   - Back-relations on `Customer`, `User`, `Part` as needed. Match house schema-comment style (load-bearing rules in comments).
2. **Migration 1 — `<ts>_document_templates/`**: hand-written via the `/create-migration` skill or the `migrate diff` workflow (`migrate dev` refuses without a TTY — do NOT try it). Structures only. No enum ADD VALUE anywhere → single directory is correct.
3. **Migration 2 — `<ts>_seed_standard_templates/`**: one `DocumentTemplate` per docType named **"Standard"**, `isDefault = true`, with a v1 `PUBLISHED` `DocumentTemplateVersion` whose `config` is that type's `DEFAULT_CONFIG` as a JSON literal, and `publishedVersionId` pointed at it. **For the four standing-text blocks** (`cert_statement` on CERT, `shipper_liability_text` on SHIPPER + MOS_SHIPPER, `quote_intro_text`/`quote_liability_text` on QUOTE): the seeded value is the live `Setting` row's value where one exists, else the code default — a SQL subquery with `COALESCE`; **the `quote_liability_text` fallback must produce `""` (present key, empty string), never an absent key**. **Do NOT delete the `Setting` rows and do NOT touch `settings.ts`** — the print paths still read them until Tasks 9/11/14; retirement is Task 14's (the plan's red-gate-window rule). Generated ids: use the house cuid approach for migration-seeded rows (look at how `20260808230100`'s BillingConfig seed or other seed migrations mint ids — follow the precedent). Apply BOTH migrations to BOTH databases; `npx prisma generate`; `migrate status` clean on both.
4. **Registrations:**
   - `AuditableModel` + `SNAPSHOT_INCLUDE`: `DocumentTemplate` (+ assignments relation), `DocumentTemplateVersion`, `CustomerTemplateAssignment`. **`SNAPSHOT_SELECT`** (the `signatureImage`/`fileData` mechanism in `audit.ts`) excludes `logoImage` from version snapshots; `redact()` gains `logoImage`.
   - `truncateAll()` (`erp/tests/helpers/db.ts`) re-seeds the 8 Standard templates + published v1s **from the TS `DEFAULT_CONFIG` constants** after TRUNCATE (the BillingConfig precedent — the print path may assume a default template always exists). Setting values in the re-seed: the code defaults (tests start from factory state).
   - §5.14 blocker registry: `CustomerTemplateAssignment.templateId` (deleting a template with live assignments must be refusable-and-nameable — the service arrives in Task 4; the registry entry keeps the FK sweep green now).
   - Partial-unique sweep (`tests/partial-unique-sweep.test.ts`): the two new partial-unique columns join; keep every `@@unique(` single-line (the sweep's known regex limit).
5. **The drift guard** (`erp/tests/template-seed.test.ts`): **parse the config JSON literal out of `_seed_standard_templates/migration.sql` itself** and deep-equal it against the TS `DEFAULT_CONFIG` per type (do NOT assert against the live DB — `truncateAll()` re-seeds from the same constants, which would be a tautology; the plan's review caught exactly this). Also assert: the SQL's standing-text COALESCE fallbacks equal the code defaults; the quote literal carries `pageFooter: true`; the en-dash survives the SQL encoding.

## Tests (TDD; RED evidence snippet REQUIRED in your report)

The drift guard; a smoke test that a raw-prisma read after `truncateAll()` sees 8 live Standard templates each with a published v1 and `isDefault`; sweep updates green; the audit-registry addition compiles (the tx-required helper types force correctness); all existing tests green.

## Conventions

Four gates watched from `erp/` with real numbers; `migrate status` clean on BOTH DBs (show it); conventional commits, no attribution trailer; no UI/flow → E2E n/a; do not touch `src/server/**` beyond `audit.ts` registrations (services are Tasks 4–5); update your ledger row.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-03-report.md`: the migration SQL decisions (id minting, JSON encoding, the COALESCE shape), RED evidence, gate numbers, deviations with reasons, notes for Task 4 (the service that builds on these tables). Final message: 5-line summary + report path.
