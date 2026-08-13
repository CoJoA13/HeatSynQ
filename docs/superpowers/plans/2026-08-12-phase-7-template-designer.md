# Phase 7 — Template Designer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The eight document types become data-driven templates — multiple per type, one always-existing default, per-customer assignment resolved division→ancestors→default, draft → publish versioning with immutable published versions — edited in a structured, contract-driven visual editor with live preview against real records. Every default Phases 3–6 hardcoded becomes editable (labels, number/date formats, column widths, fonts, logo, standing texts, section/field layout); the render runtime gains "Page N of M" and per-sheet-group rendering for every type; `Part.processName` fills the traveler's Process: slot and the invoice's create-time snapshot; issues #36, #43, #87, #97, #98 land as riders. Testable outcome: **the owner restyles the traveler and its logo through the editor, publishes, prints, and the stored PDF carries it.**

**Architecture:** One typed **template contract** per docType (`src/lib/template-contracts/` — client-safe, pure declarations) is the single source of truth for sections, fields, locked elements, text blocks, and format knobs; the zod config schema is generated from it, the editor renders from it, and each builder consumes a validated `TemplateConfig` — builders stay the layout engine (code interpreting data; §8's structured-not-painter boundary). **Parsing a stored config always backfills contract defaults for keys the version predates** (spec §5.3), so old versions keep rendering identically as contracts grow. `DocumentTemplate` holds the `publishedVersionId` pointer; prints resolve it under their own transactions, **correct at any isolation by immutability, not locking** (published versions are immutable and never deleted; drafts never print; a print racing a publish may use the prior version, accepted by design). `render.ts` stays the only pdfmake-aware file and gains the declarative footer/continuation-header specs, the pdf-lib merge (confined to this module), the 4-family vendored font map, and JPEG embedding.

**Tech Stack:** Next.js 16 (App Router) · React 19 · Prisma 7 · PostgreSQL 18 · TypeScript 5.9 · Vitest 3 (real `erp_test` DB) · Playwright · pdfmake (server, `PdfPrinter`) · **pdf-lib (new, owner-approved 2026-08-12)** · exceljs.

**Binding documents:** the approved Phase 7 spec `docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md` (§ references below; its §3 rulings 1–7 and the four plan-time confirmations — **4-family fonts, refuse >100 loads, "Standard" seed naming, walk-to-root resolution** — are the contract); the original spec's §3 non-goals, §8, and §15 (incl. the Phase 7 amendment table); `CLAUDE.md` house rules. This plan was adversarially reviewed on two lenses (coverage, sequencing) 2026-08-12; both APPROVE-WITH-FIXES, all findings incorporated.

## Global Constraints

Every task's requirements implicitly include this section.

- **All commands run from `erp/`.** TDD per task: failing test → red → implement → green → commit. Conventional commits, **no attribution trailer** (PR body only).
- **Migrations are hand-written and applied to BOTH databases** (`/create-migration` skill or the `migrate diff` workflow; `npx prisma generate` after). `migrate dev` refuses without a TTY.
- **Services own business rules; routes stay thin** (`mustCan`/`mustDo` first line, `.strict()` zod, delegate; `HttpError` for expected failures, field-anchored).
- **Every mutation through the audit helpers** on the caller's `tx`; new auditable models join `AuditableModel` + `SNAPSHOT_INCLUDE`; `logoImage` excluded via `SNAPSHOT_SELECT` (the `signatureImage` precedent) and added to `redact()`; **draft edits audit real before→after `config` diffs**.
- **Client components must not import from `src/server/**`** — the contracts live in `src/lib/template-contracts/` precisely so the editor can import them.
- **Soft delete only**; partial-unique on soft-deletable unique columns; never `findUnique`/`upsert` on a live-rows-only column. `DocumentTemplateVersion` has **no delete path at all** (discard = `DISCARDED` status flip; published rows immutable).
- **Row locks, not isolation, guard cross-transaction invariants** — publish, draft-open, set-default, assignment, **and template delete** all act under the template row's `SELECT … FOR UPDATE` claim (delete under the claim closes the assign-vs-delete race; `resolveTemplateForPrint` additionally skips assignments whose template is soft-deleted, belt-and-braces). A concurrency test that passes is not evidence unless **RED-verified** with the guard removed and the competing caller pinned to Read Committed. The publish-vs-print relationship is the deliberate exception: safety by version immutability, and the test asserts THAT (a print never observes a draft or a half-published state), not lock ordering.
- **Golden compatibility is a standing gate from Task 7 on:** every pre-existing PDF content test passes unchanged when its document renders through the seeded "Standard" config. Pin content, never `Buffer.compare` fresh renders.
- **`pdf-lib` is used only inside `src/server/pdf/render.ts`'s module boundary.** No other file imports it.
- **Run `npm run test:e2e` on any UI/flow-touching change** (dev server + DEV db `erp`; clear fixtures afterwards). **A gate row is written after watching the run end, or it says PENDING.**
- **§5.14 / §5.15 / §5.16 / §5.17** apply to every new screen and delete path.
- **Quality gates:** `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`, `npm run test:e2e`.
- **The execution record** lives in `docs/execution/2026-08-12-phase-7-template-designer/` and is **committed on the first task**.

---

## File map

**Create:**
- `erp/src/lib/template-contracts/` — `types.ts` (contract + config type machinery, zod generation, `validateConfig(docType, json)` — **applies contract defaults for absent keys**, the §5.3 backfill), `traveler.ts`, `shipper.ts`, `mos-shipper.ts`, `bol.ts`, `cert.ts`, `invoice.ts`, `statement.ts`, `quote.ts` (each: sections/fields/locks/text-blocks/knobs + `DEFAULT_CONFIG`), `index.ts` (the `CONTRACTS` registry by docType).
- `erp/src/server/templates.ts` — template + version service: create (opens its v1 DRAFT in the same act — spec §5.1)/rename, draft open (versionNumber allocated under claim; **optional source version N** for the revert flow — config+logo copied from it), draft edit (`updatedAt` precondition → named 409), discard (status flip), publish (under claim, moves `publishedVersionId`), set-default (one-per-type normalization; refuses never-published), reasoned delete (**under the template claim**; §5.17; §5.14-blocked on live assignments; default-delete refused), logo upload (PNG/JPEG magic-byte sniff, 512KB cap), version history reads.
- `erp/src/server/template-assignments.ts` — assign/clear per (customer, docType) (refuses never-published; `edit_templates`-gated), `resolveTemplateForPrint(tx, docType, customerId)` — walk `parentId` to root, nearest live assignment on a **live** template wins, else the type's default; returns `{ templateId, versionId, config, logo }`.
- `erp/src/server/pdf/fonts/` — vendored `.ttf` assets: Roboto, Liberation Sans, Liberation Serif, Roboto Mono (SIL-OFL license files alongside).
- Routes: `erp/src/app/api/templates/route.ts` (GET list, POST create), `api/templates/names/route.ts` (**`requireUser`-only** id/name/docType of live templates — §5.15), `api/templates/[id]/route.ts` (GET/PATCH/DELETE), `api/templates/[id]/draft/route.ts` (POST open — accepts optional `fromVersion`, PATCH edit, DELETE discard), `api/templates/[id]/publish/route.ts`, `api/templates/[id]/default/route.ts`, `api/templates/[id]/logo/route.ts`, `api/templates/[id]/preview/route.ts`, `api/templates/[id]/blockers/export/route.ts`, `api/customers/[id]/template-assignments/route.ts`.
- Pages: `erp/src/app/admin/templates/page.tsx` + `Templates.tsx` (list), `erp/src/app/admin/templates/[id]/page.tsx` + `TemplateEditor.tsx` (+ panel components + preview pane).
- Tests: `erp/tests/template-contracts.test.ts`, `templates.test.ts`, `template-assignments.test.ts`, `template-routes.test.ts`, `template-seed.test.ts` (the drift guard — **parses the seed migration's SQL literal**), `render-primitives.test.ts`; E2E `erp/tests/e2e/templates.spec.ts` + a checked-in fixture logo PNG under `erp/tests/e2e/fixtures/`.
- Migrations (**three**): `<ts>_document_templates/` (enum + 3 tables + `Part.processName` + `StoredDocument.templateVersionId`), `<ts>_seed_standard_templates/` (8 × "Standard"; **Setting values copied, rows NOT deleted** — a deliberate timing refinement of spec §9: the print-path consumers survive until Tasks 9/11/14), `<ts>_retire_standing_text_settings/` (Task 14 — deletes the orphaned rows once the last consumer converts).

**Modify:**
- `erp/prisma/schema.prisma` — per spec §4.
- `erp/src/server/pdf/render.ts` — footer spec, continuation-header spec, `renderSheetGroups` (pdf-lib merge, `save({ useObjectStreams: false })` so the `/Count N` content assertions keep working), font map, JPEG data-uri.
- `erp/src/server/documents.ts` — **Task 7**: `storeDocument` gains optional `templateVersionId` (written to the row); **Task 13**: the shared safe-Content-Disposition helper (#87).
- All eight builders + their data readers/print brackets: `traveler.ts`, `pdf/shipping-ticket.ts`, `pdf/bol.ts`, `pdf/cert.ts`, `pdf/invoice.ts`, `pdf/statement.ts`, `pdf/quote.ts` + `shippers.ts`, `certs.ts`, `invoices.ts`, `statements.ts`, `quotes.ts` (config param; resolution + `templateVersionId` stamp; per-doc extras below).
- `erp/src/server/audit.ts`; `erp/src/server/settings.ts` + `erp/src/lib/settings-ui.ts` + their tests (**Task 14 only** — the four keys retire there, not earlier); `erp/src/server/customers.ts` (`deleteCustomer` cascades template assignments — Task 5); `erp/src/lib/reference-links.ts`/blocker registries; `erp/src/server/parts.ts` + parts UI (+ export/paste) for `processName`; `erp/src/server/invoices.ts` (`processNames` snapshot source + #98); `erp/src/server/quotes.ts` (#97); customer page (assignment picker); `erp/src/components/Shell.tsx` (**Task 16** — the Templates nav entry, gated on `templates.view`); `next.config.ts` (`outputFileTracingIncludes`); `package.json` (pdf-lib); sweep tests; `tests/helpers/db.ts` (truncateAll re-seed from TS constants).
- Docs at the final task: `docs/HANDOFF.md`, `CLAUDE.md` (the new standing conventions: template contracts/locked elements + default backfill, publish-by-immutability, pdf-lib confinement), execution ledger throughout.

---

## Task 1: Contract machinery + the order-side contracts (traveler, shipper, MOS shipper, BOL)

**Files:** `erp/src/lib/template-contracts/{types,traveler,shipper,mos-shipper,bol,index}.ts`; `erp/tests/template-contracts.test.ts`.

- [ ] **Step 1 — machinery.** Contract types (sections, fields, locks, text blocks, knobs), config types, zod-schema generation (`.strict()` everywhere), `validateConfig`, width-total validation against 564pt, the locked-element refusal, and **the §5.3 default backfill**: parsing a stored config applies the contract's defaults for every absent key, so a version stored before a knob existed keeps rendering identically — with a test that adds a synthetic knob and re-parses an old config.
- [ ] **Step 2 — the four contracts**, derived from the existing builders/`<Doc>Data` types: every printed section/field/label/column-width/text-block enumerated with stable keys; traveler marks steps + barcode **locked**; BOL's UDSBL legal constants become its text blocks' defaults; each type's `DEFAULT_CONFIG` reproduces today's hardcoded values exactly.
- [ ] **Step 3 — tests.** Defaults validate; locked-element and width-overflow configs refused; unknown keys refused; label/format/width overrides round-trip. Commit the execution ledger with this task.

## Task 2: The billing-side contracts (cert, invoice, statement, quote)

**Files:** `erp/src/lib/template-contracts/{cert,invoice,statement,quote}.ts` + registry; tests extended.

- [ ] **Step 1 — cert**: internal no-print notes NEVER appear as a field (test asserts the contract omits them); `cert_statement` as a text block; `shipper_liability_text` retro-checked onto the shipper contract (Task 1).
- [ ] **Step 2 — invoice**: fields map ONLY to the frozen snapshot columns (test walks the contract against `InvoicePdfData`); covers credits (negative-format knob lives here).
- [ ] **Step 3 — statement + quote** contracts (`quote_intro_text`/`quote_liability_text` as quote text blocks); number/date knobs per spec §5.3; all eight registered in `CONTRACTS`; gates green.

## Task 3: Schema, migrations, seeds, and registrations

**Files:** `erp/prisma/schema.prisma`; the first two migration directories; `erp/src/server/audit.ts`, `erp/tests/helpers/db.ts`, sweep tests, `erp/tests/template-seed.test.ts`.

- [ ] **Step 1 — schema** per spec §4: `TemplateDocType` enum (8 values), `DocumentTemplate` (partial-unique `[docType, name]`), `DocumentTemplateVersion` (no `deletedAt`; `@@unique([templateId, versionNumber])`), `CustomerTemplateAssignment` (partial-unique `[customerId, docType]`), `Part.processName String @default("")`, `StoredDocument.templateVersionId String?` + FK + index (kind→owner CHECK untouched — comment why), back-relations.
- [ ] **Step 2 — migrations.** `_document_templates` (structures); `_seed_standard_templates`: one "Standard" per type, `isDefault`, v1 `PUBLISHED`, config = the type's `DEFAULT_CONFIG` as a SQL literal **with the four standing-text values copied from live `Setting` rows (subquery, code-default fallback)**. The `Setting` rows and registry keys are **NOT retired here** — their print-path consumers convert in Tasks 9/11/14; retirement completes in Task 14 (deleting them now would silently revert owner-edited standing texts for the rest of the branch). Both DBs; `prisma generate`.
- [ ] **Step 3 — registrations.** Audit registries (+`SNAPSHOT_SELECT` logoImage, `redact()` logoImage); `truncateAll()` re-seeds the 8 templates **from the TS `DEFAULT_CONFIG` constants**; §5.14 registry entries (`CustomerTemplateAssignment.templateId`); partial-unique sweep entries.
- [ ] **Step 4 — the drift guard** (`template-seed.test.ts`): **parses the config JSON literal out of `_seed_standard_templates/migration.sql` itself** and deep-equals it against the TS `DEFAULT_CONFIG` per type (asserting against the live DB would be a tautology — `truncateAll()` re-seeds from the same constants before every test). `migrate status` clean on both DBs; all gates green.

## Task 4: The template service — lifecycle, publish, delete

**Files:** `erp/src/server/templates.ts`; the template routes (minus preview/assignments); `erp/tests/templates.test.ts`, `template-routes.test.ts`.

- [ ] **Step 1 — lifecycle.** Create (named per type; **opens its v1 DRAFT in the same act** — spec §5.1); draft open under the template claim (versionNumber allocated; config+logo copied from the published version, **or from an explicit source version N — the §5.1 revert flow** — or `DEFAULT_CONFIG`; at most one live DRAFT — refused otherwise); draft edit (config validated against the contract; **`updatedAt` precondition → named 409**; audited with config diffs); discard (status flip, audited); publish under the claim (status flip + `publishedAt`/`publishedById`, pointer moves — the `lockCurrentRevision` shape).
- [ ] **Step 2 — guards.** Published rows immutable (no update path; test proves it); set-default refuses never-published + normalizes one-per-type in one transaction; reasoned delete (§5.17, trimmed non-empty in the service) **claims the template row**, is refused for the current default, and is §5.14-blocked-and-named on live assignments (+ Excel export route); logo upload sniffed (PNG/JPEG magic bytes, 512KB) onto the DRAFT only.
- [ ] **Step 3 — permissions.** `templates` area CRUD on all routes; `edit_templates` (`mustDo`) on publish + set-default. Permission sweep picks the routes up.
- [ ] **Step 4 — concurrency, RED-verified.** Publish-vs-draft-open, double-publish, and **delete-vs-assign** under the claim (remove the claim → red, Read-Committed competitor); draft-edit 409; **draft-never-prints** shaped per the immutability argument: a concurrent reader never observes DRAFT status or a dangling pointer.

## Task 5: Assignment + print-time resolution

**Files:** `erp/src/server/template-assignments.ts`, `erp/src/server/customers.ts`; `api/customers/[id]/template-assignments/route.ts`, `api/templates/names/route.ts`; `erp/tests/template-assignments.test.ts`.

- [ ] **Step 1 — assignment service**: assign/clear per (customer, docType), refuses never-published templates, `edit_templates` + `customers.edit` gated, audited; clearing needs no reason (§5.17 classification — spec §7). **`deleteCustomer` cascades the customer's template assignments** (the explicit `auditedSoftDelete` loop, the addresses/contacts pattern) — with a test.
- [ ] **Step 2 — `resolveTemplateForPrint`**: walk `parentId` to root (cycle-safe bound), nearest live assignment **whose template is itself live**, else the type default; **never null** (the seed + truncateAll guarantee); reads on the caller's `tx`.
- [ ] **Step 3 — the names read** (`requireUser` only — §5.15) and tests: deep-tree resolution, soft-deleted assignment ignored, deleted-template assignment skipped, default fallback, the never-published refusal end-to-end.

## Task 6: Render runtime — page numbers, sheet groups, fonts, pdf-lib

**Files:** `erp/src/server/pdf/render.ts`, `erp/src/server/pdf/fonts/*`, `next.config.ts`, `package.json`; `erp/tests/render-primitives.test.ts`.

- [ ] **Step 1 — declarative specs.** Footer spec (`pageNofM`) and continuation-header spec (static JSON content, every page after the first) carried on the definition; callbacks constructed only inside `render.ts` (the named-table-layouts indirection). Definitions stay JSON-serializable — round-trip test. Existing builders untouched and their tests still green (the specs are opt-in keys).
- [ ] **Step 2 — `renderSheetGroups(defs[])`**: renders each group, merges with **pdf-lib** (only import site: this file), **`save({ useObjectStreams: false })`** so the uncompressed `/Count N` page marker survives for content assertions; returns one PDF.
- [ ] **Step 3 — fonts.** Vendor the 4 families (Roboto, Liberation Sans, Liberation Serif, Roboto Mono) as `.ttf` + licenses; buffers at module load; `outputFileTracingIncludes` so `next build` standalone carries them (verify with `npm run build`); font map registered per render — **Roboto keeps its existing key so every unconverted builder (and the posting register) renders unchanged mid-branch**; unknown family in config fails validation (contract-side, Task 1).
- [ ] **Step 4 — JPEG data-uri** helper beside `pngDataUri`. All gates incl. `build` green.

## Task 7: Traveler conversion (+ processName slot, the stamp plumbing)

**Files:** `erp/src/server/traveler.ts`, `erp/src/server/documents.ts`; `erp/tests/traveler.test.ts`.

- [ ] **Step 1 — stamp plumbing.** `storeDocument` gains optional `templateVersionId`, written to the row (documents.ts — Tasks 8–14 just pass it).
- [ ] **Step 2 — config consumption.** `buildTravelerDefinition(data, config)`: sections/fields/labels/widths/fonts/logo/formats from config; steps + barcode locked (validator already refuses; builder renders them regardless); the Process: slot binds `part.processName` (blank → nothing). **Golden compat: existing traveler tests pass unchanged under the seeded config.**
- [ ] **Step 3 — print path.** `printTraveler` resolves via `resolveTemplateForPrint` on its claimed `tx` (isolation deliberately unchanged — the immutability argument, spec §5.1), stamps `templateVersionId`. E2E (print flows touched): run, watch it end, record.

## Task 8: Traveler sheet groups — #36 + #43

**Files:** `erp/src/server/traveler.ts`; regression tests.

- [ ] **Step 1 — #36.** Per-load sheet groups through `renderSheetGroups`: each load's continuation header carries ITS order/load/barcode; each sheet group restarts "Page 1 of N"; overflow regression test (a 20+-step recipe).
- [ ] **Step 2 — #43.** The all-loads print **refuses above 100 loads** with a named 400 pointing at per-load printing; the order-row lock never spans an unbounded render; regression test at the boundary. E2E; gates; close-verification noted in the ledger.

## Task 9: Shipping ticket + MOS conversion (+ tear-off reflow)

**Files:** `erp/src/server/pdf/shipping-ticket.ts`, `erp/src/server/shippers.ts`; tests.

- [ ] **Step 1 — config consumption** for BOTH `SHIPPER` and `MOS_SHIPPER` contracts (one builder, two configs); `shipper_liability_text` renders from config (the Setting key keeps working elsewhere until Task 14). Golden compat.
- [ ] **Step 2 — resolution by the shipment's order count** — a multi-order shipment's per-order ticket also resolves `MOS_SHIPPER` (spec §5.2); stamp `templateVersionId`.
- [ ] **Step 3 — tear-off goes flow-based** (no `absolutePosition`): reflows under width overrides and many part rows (the >8-row overlap regression test), tear-off content preserved.
- [ ] **Step 4 — per-ticket sheet groups**: "Page N of M" per ticket via `renderSheetGroups`. E2E; gates.

## Task 10: BOL conversion

**Files:** `erp/src/server/pdf/bol.ts`, `erp/src/server/shippers.ts`; tests.

- [ ] **Step 1 — config consumption**; the UDSBL legal text renders from the config's text blocks (defaults seeded from today's constants). Golden compat.
- [ ] **Step 2 — resolution + stamp + Page N of M.** E2E; gates.

## Task 11: Cert conversion

**Files:** `erp/src/server/pdf/cert.ts`, `erp/src/server/certs.ts`; tests.

- [ ] **Step 1 — config consumption**; `cert_statement` from config; signature block semantics untouched; the contract-omits-internal-notes test rides here against the real data path. Golden compat.
- [ ] **Step 2 — resolution + stamp + Page N of M** (multi-part certs stay one sheet group). E2E; gates.

## Task 12: Invoice/credit conversion (+ processName snapshot, #98)

**Files:** `erp/src/server/pdf/invoice.ts`, `erp/src/server/invoices.ts`; tests.

- [ ] **Step 1 — config consumption**; number/negative/date formats exercised on a credit fixture; fields bind frozen snapshot columns only. Golden compat.
- [ ] **Step 2 — `processNames` snapshot source**: invoice assembly writes `part.processName` when non-blank, else today's comma-join — **create-time only**; a `processName` edit after finalize provably changes nothing (test). Pre-existing invoices untouched.
- [ ] **Step 3 — #98** (`sourceQuoteNumber` `.refine`) + resolution/stamp/Page N of M (both invoice and credit resolve `INVOICE`). E2E; gates.

## Task 13: Statement conversion (+ #87)

**Files:** `erp/src/server/pdf/statement.ts`, `erp/src/server/statements.ts`, `erp/src/server/documents.ts` + document/statement routes; tests.

- [ ] **Step 1 — config consumption** + resolution (the statement's customer; walk applies) + stamp + **Page N of M** (spec §6.1 covers every type). Golden compat.
- [ ] **Step 2 — #87**: the shared safe-Content-Disposition helper (RFC 5987), adopted by every filename-emitting route (document download + statement print); hostile-code regression test (newline/quote in customer code → clean response, no orphaned archive).

## Task 14: Quote conversion (+ #97, settings retirement completes)

**Files:** `erp/src/server/pdf/quote.ts`, `erp/src/server/quotes.ts`, `erp/src/server/settings.ts`, `erp/src/lib/settings-ui.ts`, the third migration; tests.

- [ ] **Step 1 — footer callback retired** for the `pageNofM` spec; the builder joins the purity round-trip tests (delete the recorded exemption). Config consumption; `quote_intro_text`/`quote_liability_text` from config. Golden compat.
- [ ] **Step 2 — #97** (`ops.length === line.prices.length` assert) + resolution/stamp.
- [ ] **Step 3 — settings retirement completes** (the last standing-text consumer converts here): the four keys leave `settings.ts`/`settings-ui.ts` and their tests, and `_retire_standing_text_settings` deletes the orphaned `Setting` rows (values were copied into the seeds in Task 3) — closing spec §8's retirement. Both DBs. E2E; gates.

## Task 15: `Part.processName` UI

**Files:** parts form/UI, `erp/src/server/parts.ts`, export/paste columns; tests.

- [ ] **Step 1 — the field** on the part form (optional, plain text), export + spreadsheet-paste columns, audit diff. E2E.

## Task 16: Templates admin — list, lifecycle UI, version history, nav

**Files:** `erp/src/app/admin/templates/**`, `erp/src/components/Shell.tsx`; E2E.

- [ ] **Step 1 — list page + nav**: 8 types × templates, default starred, assignment counts, create/rename; **Shell.tsx gains the Templates entry gated on `templates.view`** (the admin group's visibility keys per-entry rather than `admin.view` alone — Shell keeps *hiding*, per the §5.16 nav exception; decide submenu-vs-top-level in the task and record it); §5.16 disabled-with-reason throughout the page.
- [ ] **Step 2 — lifecycle UI**: draft open/discard/publish (publish behind `edit_templates` — §5.16 tooltip), version history with "open draft from version N" (the Task 4 service parameter), reasoned delete with the §5.14 blocker list + Excel export.
- [ ] **Step 3 — E2E**; gates.

## Task 17: The structured editor — panels

**Files:** `TemplateEditor.tsx` + panel components; the E2E fixture logo PNG (`erp/tests/e2e/fixtures/`); E2E.

- [ ] **Step 1 — contract-driven panels** (one component tree, all 8 types): section show/hide/reorder, field add/remove/reorder + label overrides, column widths (validated live + server-side), format pickers, fonts, text blocks. Locked elements render locked with the reason.
- [ ] **Step 2 — logo panel**: upload (fixture PNG checked in for tests) + placement slots + width. E2E; gates.

## Task 18: The structured editor — draft save and conflict UX

**Files:** `TemplateEditor.tsx`; E2E.

- [ ] **Step 1 — draft save** wired to the PATCH with the `updatedAt` precondition; the 409 path surfaced as a reload-vs-overwrite choice; the error banner is never cleared by a subsequent reload (§5.13's lesson — roll back to server truth first, then report).
- [ ] **Step 2 — E2E** (edit → conflict → resolve); gates.

## Task 19: Preview

**Files:** `api/templates/[id]/preview/route.ts`, the preview pane, per-type pickers; tests + E2E.

- [ ] **Step 1 — the render**: POST draft (or published) config + picked record → PDF bytes streamed; **no `StoredDocument`, no `printedAt`, no side effects**; statement preview forces finance-charge assessment OFF, takes `asOf`/`combineFamily` (defaults today/false).
- [ ] **Step 2 — pickers**: order / shipment (MOS ↔ multi-order filter, SHIPPER ↔ single) / cert / invoice **or credit** / customer / quote, via the house search components.
- [ ] **Step 3 — gates**: `templates.view` + the type's print-route permission (`receivables.view` for statements); route tests prove the pairing. E2E; gates.

## Task 20: Customer-page assignment picker

**Files:** customer detail page, `api/customers/[id]/template-assignments/route.ts` wiring; E2E.

- [ ] **Step 1 — the picker** (per docType) fed by the `requireUser`-only names read (no silent-empty dropdown — §5.15); assign/clear behind `edit_templates` with §5.16 tooltips; inherited-from-parent and type-default states displayed, not blank.
- [ ] **Step 2 — E2E**; gates.

## Task 21: The restyle E2E flow, docs, final gates

**Files:** `erp/tests/e2e/templates.spec.ts`; `docs/HANDOFF.md`, `CLAUDE.md`; the ledger.

- [ ] **Step 1 — the roadmap outcome as a flow**: create draft from Standard traveler → upload the fixture logo + rename a label → preview → publish → print a real order's traveler → assert the stored PDF's content markers (and `templateVersionId` stamped).
- [ ] **Step 2 — docs**: HANDOFF (§4 state, moving numbers), CLAUDE.md (template contracts + locked elements + default backfill; publish-by-immutability; pdf-lib confinement; the four retired settings keys), close-out notes for #36/#43/#87/#97/#98 (closed from the branch as fixed).
- [ ] **Step 3 — full gates watched to completion** (vitest, tsc, eslint, build, E2E) — rows written from the runs' own output.
