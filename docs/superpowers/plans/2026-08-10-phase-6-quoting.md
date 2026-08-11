# Phase 6 — Quoting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build quoting as a standing price agreement: quotes with part/price lines in 5A's exact price vocabulary (breaks included), a follow-up/expired worklist, per-order-line auto-link at order entry (latest-effective-wins, overridable), wholesale tier-1 substitution at invoice assembly with the quote number frozen onto every line it prices, close/reopen with reason, and the quote PDF (eighth document type) built to the owner's sample — plus the `endingStatement` reference kind and `User.title`.

**Architecture:** A dependency-free eligibility leaf (`quote-links.ts`) answers "which quote line prices this customer + part as of this received date" for order entry, the quote service's close warning, and the part page — the `order-locks.ts`/`invoice-guards.ts` precedent, created *before* the `orders.ts ↔ quotes.ts` cycle can exist. The quote service (`quotes.ts`) owns the lifecycle under its own row claim. Invoice assembly branches per order line: a live `quoteLineId` swaps the line's `PriceRowInput[]` source from `listPartPrices` to the quote's rows — the pure engine (`pricing.ts`) gains only pass-through `priceSource`/`sourceQuoteNumber` fields and no math changes. The invoice stays frozen paper (`InvoiceLine.sourceQuoteNumber` read unconditionally); the quote stays a living document whose frozen artifacts are its stored PDFs.

**Tech Stack:** Next.js 16 (App Router) · React 19 · Prisma 7 (client generated into `prisma/generated/`, gitignored) · PostgreSQL 18 · TypeScript 5.9 · Vitest 3 (integration against the real `erp_test` DB) · Playwright · pdfmake (server, via `PdfPrinter`) · exceljs.

**Binding documents:** the approved spec `docs/superpowers/specs/2026-08-10-phase-6-quoting-design.md` (§ references below point at it; its §3 rulings 1–14 are the contract); the original spec's §3 non-goals and §15 decision log (incl. the Phase 6 amendment table); `CLAUDE.md` house rules; the PDF build target `docs/samples/Quote_Sample_Form.jpeg`.

## Global Constraints

Every task's requirements implicitly include this section.

- **All commands run from `erp/`.** Source is `erp/src/**`, tests `erp/tests/**`, schema `erp/prisma/**`.
- **TDD per task:** failing test → run it red → minimal implement → run it green → commit. Vitest against the real `erp_test` DB; `truncateAll()` in `beforeEach`; `fileParallelism: false` (never parallelize).
- **Conventional commits, NO attribution trailer on individual commits** (owner rule, 2026-08-01). Attribution goes in the PR body only.
- **Migrations are hand-written and applied to BOTH databases.** `npx prisma migrate dev` refuses without a TTY. Use the `/create-migration` skill, or: edit `schema.prisma` → `npx prisma migrate diff --from-config-datasource --to-schema=prisma/schema.prisma --script` → read the full output → hand-write `prisma/migrations/<timestamp>_<name>/migration.sql` → `npx prisma migrate deploy` (dev) → `DATABASE_URL="postgresql://erp:erp_local_dev@localhost:5432/erp_test" npx prisma migrate deploy` → `npx prisma generate`.
- **Services own business rules; routes stay thin:** `mustCan(await requireUser(req), area, action)` first line, `SCHEMA.strict().parse(await req.json())`, delegate. Expected failures are `throw new HttpError(status, message)`, field-anchored.
- **Every mutation goes through `auditedCreate`/`auditedUpdate`/`auditedSoftDelete`** on the caller's `tx`; new auditable models join `AuditableModel` **and** `SNAPSHOT_INCLUDE` (relations!).
- **Client components must not import from `src/server/**`** — mirror server types locally; shared constants in `src/lib/`.
- **Soft delete only** (`deletedAt`); unique columns on soft-deletable models get the partial-unique treatment; **never `findUnique`/`upsert` on a live-rows-only column** (`findFirst({ where: { …, deletedAt: null } })`). `Quote.quoteNumber` is the deliberate exception: plain `@unique`, allocation-only, documented sweep exemption beside `Order.orderNumber`.
- **Route handler tests pass ctx:** `handler(request, { params: Promise.resolve({...}) })`.
- **Row locks, not isolation, guard cross-transaction invariants**; claim with `SELECT … FOR UPDATE` before reading the state acted on. A concurrency test that passes is **not** evidence unless RED-verified with the guard removed and the competing caller pinned to Read Committed.
- **PDF output is not byte-deterministic across renders** — pin content, never `Buffer.compare` two fresh renders. Stored-byte reprints stay exact.
- **Run `npm run test:e2e` whenever a change touches any UI/flow** (dev server + DEV db `erp`; clear fixtures out of the dev DB afterwards).
- **§5.14 / §5.15 / §5.16 / §5.17** apply to every new screen and delete path (blockers named + Excel; pick-lists via `/api/picklists`; disabled-with-reason controls; reasons trimmed non-empty in the service).
- **Quality gates that must stay green:** `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build`, `npm run test:e2e`.

---

## File map

**Create:**
- `erp/src/server/quote-links.ts` — dependency-free LEAF: the eligibility rule (spec §5.2 — OPEN, live, customer match, part match, `effectiveDate ≤ receivedDate ≤ expiryDate` inclusive), `eligibleQuoteLines(tx, customerId, partId, receivedDate)`, `resolveAutoLink(...)` (latest-effective-wins, tie → higher quoteNumber), `linkedOpenOrders(tx, quoteId)` (the close warning / §5.14 blocker query). Reads on the caller's client; throws nothing; checks no permission.
- `erp/src/server/quotes.ts` — the quote service: create/get/list/worklist, update (row claim), close/reopen, delete, attach-part, Excel export data.
- `erp/src/server/pdf/quote.ts` — pure `TDocumentDefinitions` builder to the sample (spec §6), fed precomputed data incl. engine-computed indicative amounts.
- `erp/src/lib/quote-constants.ts` — client-safe: statuses (`OPEN`/`CLOSED`), labels, worklist keys.
- Routes: `erp/src/app/api/quotes/route.ts` (GET list+worklist, POST create), `api/quotes/[id]/route.ts` (GET/PATCH/DELETE), `api/quotes/[id]/close/route.ts`, `api/quotes/[id]/reopen/route.ts`, `api/quotes/[id]/print/route.ts`, `api/quotes/[id]/blockers/export/route.ts`, `api/quotes/export/route.ts` (Excel list), `api/quotes/eligible/route.ts` (entry UI resolution).
- Pages: `erp/src/app/quotes/page.tsx` + `Quotes.tsx` (worklist + list), `erp/src/app/quotes/[id]/page.tsx` + `QuoteDetail.tsx`.
- Tests: `erp/tests/quotes.test.ts`, `quote-links.test.ts`, `quote-routes.test.ts`, `quote-pricing.test.ts` (tier-1 assembly), `quote-pdf.test.ts`; E2E `erp/tests/e2e/quotes.spec.ts`.

**Modify:**
- `erp/prisma/schema.prisma` + two migration directories (spec §9).
- `erp/src/server/audit.ts` — `AuditableModel` + `SNAPSHOT_INCLUDE` (Quote → lines → prices → breaks; EndingStatement rides the generic reference machinery).
- `erp/src/server/settings.ts` — `quote_valid_days`, `quote_intro_text`, `quote_liability_text`.
- `erp/src/lib/invoice-constants.ts` — `PRICE_SOURCES` + `"QUOTE"` + label ("Quote #N" display comes from `sourceQuoteNumber`).
- `erp/src/lib/reference-constants.ts`, `erp/src/server/reference.ts` — the `endingStatement` kind (+ `PICKLIST_KINDS`), `isDefault` normalization.
- `erp/src/lib/reference-links.ts` / blocker registries — `QuotePrice.processStepCodeId`, `Quote.endingStatementId`, `QuoteLine.partId`, plus `deleteCustomer`'s quote block.
- `erp/src/server/pricing.ts` — `PriceRowInput.priceSource?`/`sourceQuoteNumber?` pass-through (default `PART_PRICE`).
- `erp/src/server/invoices.ts` — per-line row-source branch, `sourceQuoteNumber` persist + credit copy, recalculate path.
- `erp/src/server/orders.ts` — auto-link at create/addLine, explicit-pick validation, part-swap re-resolve.
- `erp/src/server/documents.ts` — `AREA_FOR_KIND.QUOTE = "quotes"`, `DocumentOwner` union, `ownerColumns` arm.
- `erp/src/server/users.ts` + `erp/src/app/admin/users/**` — `User.title`.
- `erp/src/server/pdf/cert.ts` (or the cert builder's actual file) — signature title line.
- Order entry + order hub components — quote link display + re-pick/unlink; part detail page — active-quote indicator; invoice UI/PDF — "Quote #N" source display.
- Sweep tests: `partial-unique-sweep`, permissions sweep, reference-links sweep.
- Docs at the final task: `docs/HANDOFF.md`, `CLAUDE.md` (only if a standing convention changes), execution ledger `progress.md` throughout.

---

## Task 1: Schema, migrations, and every registration that keeps the gates green

**Files:** `erp/prisma/schema.prisma`; create `erp/prisma/migrations/<ts>_quote_enum_values/migration.sql` and `<ts>_quoting/migration.sql`; modify `erp/src/server/audit.ts`, `erp/src/server/settings.ts`, `erp/src/lib/invoice-constants.ts`, `erp/src/server/documents.ts`, `erp/src/lib/reference-links.ts` (registrations only), `erp/tests/partial-unique-sweep.test.ts`.

- [ ] **Step 1 — schema.** Add `Quote`, `QuoteLine`, `QuotePrice`, `QuotePriceBreak`, `EndingStatement` exactly per spec §4.1 (schema comments carry the load-bearing rules: allocation-only `quoteNumber`, XOR line identity, no GL on quote rows, judged-at-link-time). Add `OrderLine.quoteLineId String?` + index; `InvoiceLine.sourceQuoteNumber Int?` (frozen snapshot — comment it); `User.title String @default("")`; `StoredDocument.quoteId String?` + FK + index with the kind→owner comment updated; `ADD VALUE` targets: `DocumentKind.QUOTE`, `PriceSource.QUOTE`; all back-relations (`Customer.quotes`, `Part.quoteLines`, `ProcessStepCode.quotePrices`, `CustomerContact`, `User` ×2, `EndingStatement.quotes`).
- [ ] **Step 2 — migrations.** Two directories, enum `ADD VALUE`s in the earlier one (Postgres refuses same-transaction use; one directory per `migrate deploy` transaction). The `_quoting` migration: tables, columns, indexes, partial uniques (`QuotePrice(quoteLineId, processStepCodeId) WHERE deletedAt IS NULL`, `EndingStatement(name) WHERE deletedAt IS NULL`), and the `StoredDocument_kind_owner_check` DROP + re-ADD **restated whole**: new arm `QUOTE ⇒ quoteId NOT NULL` and all other owner columns null; every existing arm additionally asserts `"quoteId" IS NULL`. Apply to BOTH databases; `npx prisma generate`.
- [ ] **Step 3 — registrations.** `AuditableModel` + `SNAPSHOT_INCLUDE` (Quote pulls `lines { prices { breaks } }`); settings keys (`quote_valid_days` int default 30, `quote_intro_text` seeded with the sample's line, `quote_liability_text` default `""` — `quote_number_next` already exists, do NOT re-add); `PRICE_SOURCES` + `"QUOTE"` + label; `documents.ts` `AREA_FOR_KIND.QUOTE = "quotes"` + `DocumentOwner`/`ownerColumns` arm (tsc forces this the moment the enum gains the value); FK registry entries for `QuoteLine.partId`, `QuotePrice.processStepCodeId`, `Quote.endingStatementId` (behavioral blocker messages come in Task 7 — the registry entries keep the FK sweep green now); `Quote.quoteNumber` sweep exemption documented beside `Order.orderNumber`'s.
- [ ] **Step 4 — tests.** Sweep updates run green; a smoke test creates a Quote row via raw prisma in `quotes.test.ts` (full service TDD lands in Task 3); `migrate status` clean on both DBs; all four gates green.

## Task 2: The `endingStatement` reference kind (ruling 13)

**Files:** `erp/src/lib/reference-constants.ts`, `erp/src/server/reference.ts`, the reference admin UI config, picklist wiring; tests in the existing reference/picklist suites.

- [ ] Wire the eleventh kind: `REFERENCE_KINDS` + labels (`"Ending statement"`), `EXTRA_SCHEMAS` (`text` max 4000, `isDefault` boolean), extra-columns UI config (text + boolean rendering, Excel export), `PICKLIST_KINDS` (quote entry reads it with a session — §5.15).
- [ ] **Default normalization in the service** (the address-default precedent): a write setting `isDefault: true` clears every other live row's flag inside the same transaction, audited; deleting/deactivating the default leaves the kind defaultless (creation then stores no ending statement — nullable is legal).
- [ ] Tests: CRUD via the generic machinery, one-default invariant under concurrent writes (claim or conditional update — RED-verify), picklist projection, paste/export round-trip consistent with the kind's extra columns.

## Task 3: Quote service — create, read, list, worklist

**Files:** create `erp/src/server/quotes.ts`, `erp/src/lib/quote-constants.ts`, `erp/tests/quotes.test.ts`.

- [ ] `createQuote`: one transaction — `allocateNumber("quote_number_next", tx)`; defaults (quoteDate today, effective = quoteDate, expiry = quoteDate + `quote_valid_days`, endingStatement = the kind's live default, quotedBy = actor); validation: dates ordered (`effectiveDate ≤ expiryDate`, field-anchored 400s), line identity XOR (`partId` xor non-empty `partNumberText`), part belongs to the quote's customer, one live line per part per quote, price rows keyed to live step codes, LOT rows refuse breaks (the part-prices rule), Decimal scales per schema. `auditedCreate` with full snapshot.
- [ ] `getQuote` (detail): live part joins for linked lines (number/name/description/each-weight/material), own text for free-text lines; contact live-join rendering blank if deleted; derived `expired`; linked-order summary per line (count + order numbers).
- [ ] `listQuotes` + worklist: search (quote number, customer name/code, RFQ, part number incl. free-text), filters (status, derived expired, follow-up due, customer, date range); the two worklist queries + counts (`followUpDate ≤ today`; `expiryDate < today`; both OPEN + live); Excel export data (the house exporter).
- [ ] Tests first, per rule — boundaries **inclusive** on both date edges, free-text lines excluded from nothing list-wise but carrying no part join, concurrent `createQuote` allocating distinct numbers.

## Task 4: Quote service — update, close/reopen, delete, attach-part + routes

**Files:** `erp/src/server/quotes.ts`, the `api/quotes/**` routes, `erp/tests/quote-routes.test.ts`, additions to `quotes.test.ts`.

- [ ] `updateQuote` (OPEN only): claim the quote row `SELECT … FOR UPDATE` first; `customerId` immutable (400); header + line/price/break array-replace semantics matching the part-prices editing pattern; **refuse** (§5.14, blockers named) deleting a quote line — or changing its `partId` — while any `OrderLine.quoteLineId` references it (`quote-links.ts` provides the query); free-text edits and price-row edits are always allowed (ruling 8). `attachPart`: sets `partId` on a free-text line (same validation as create), audited.
- [ ] `closeQuote`/`reopenQuote` (`quotes.edit`): reason trimmed non-empty **in the service** (§5.17 discipline), status flip + `closedAt`/`closedById`/`closeReason`, audited; the close **response carries `linkedOpenOrders`** (open, not-yet-fully-invoiced orders still linked — warn-and-list, never block). Close is idempotence-guarded by the row claim (a second close 400s "already closed").
- [ ] `deleteQuote` (`quotes.delete`): reason required; **refused-and-named** while any order line references any of its lines — blockers listed with order links + Excel export route; soft-delete cascades lines/prices/breaks stamps via the audited path.
- [ ] Routes per the file map: thin handlers, `mustCan` per method (`view`/`create`/`edit`/`delete`), zod `.strict()`, ctx-passing tests, permission-denied cases; the permissions sweep picks them up.

## Task 5: Eligibility leaf + order-side auto-link (rulings 5–7)

**Files:** create `erp/src/server/quote-links.ts`, `erp/tests/quote-links.test.ts`; modify `erp/src/server/orders.ts`, `api/quotes/eligible/route.ts`; additions to the orders test suite.

- [ ] `quote-links.ts` (LEAF — no imports from quotes/orders/invoices): the eligibility predicate + `eligibleQuoteLines` (ordered latest-effective, then quoteNumber desc) + `resolveAutoLink` (first of that ordering or null) + `linkedOpenOrders`. Unit/integration tests: closed, expired (boundary inclusive both ends), soft-deleted quote/line, wrong customer, free-text line, tie-break by quote number.
- [ ] `orders.ts` integration, inside the existing one-transaction save (NOT a rewrite): per line — payload `quoteLineId` **explicit id** → validate eligibility (400 naming the line and reason on failure); **explicit null** → no link; **absent** → `resolveAutoLink`. Same in `addLine`; `updateLine` part-swap clears + re-resolves; received-date edits do NOT re-judge stored links (ruling 6 — test proves the link survives). The idempotent replay returns the same links (the clientRequestId path).
- [ ] `GET /api/quotes/eligible?customerId&partId&receivedDate` for the entry UI (session-gated read, `orders`-area view — it serves order entry), returning the ordered candidates + which one auto-resolves.
- [ ] Order detail/list payloads expose per-line quote number + id for display (hub + entry).

## Task 6: Tier-1 substitution at invoice assembly (rulings 4, 8) + frozen source

**Files:** `erp/src/server/pricing.ts`, `erp/src/server/invoices.ts`, `erp/src/lib/invoice-constants.ts` labels, invoice UI source display, the invoice PDF builder; create `erp/tests/quote-pricing.test.ts`.

- [ ] `pricing.ts`: `PriceRowInput` gains optional `priceSource` (default `"PART_PRICE"`) and `sourceQuoteNumber` (default null); `priceOrder` emits them onto the OPERATION line instead of hardcoding. Pure-engine tests only — no math change proven by the existing suite staying green.
- [ ] `invoices.ts` assembly (both build sites — the per-line builder and the lead-price path): if the order line carries a live `quoteLineId` → rows from that quote line's live `QuotePrice`/`QuotePriceBreak` (deletedAt-filtered, ordered by position), GL resolved from each row's step code exactly as `listPartPrices` resolves it, `priceSource: "QUOTE"`, `sourceQuoteNumber`; **assert** `quoteLine.partId === orderLine.partId` (invariant — a mismatch throws, it is a bug not an expected failure); a linked line with zero live rows produces the empty-array needs-price branch, **never** the part-price fallback (ruling 4 — RED-verify by asserting the part's rows do not appear). Reads happen on the invoice's own Serializable `tx` client (the #60 lesson).
- [ ] Persist `sourceQuoteNumber` on `InvoiceLine` at write; `createCredit`'s line copy carries it; recalculate-under-unlock re-resolves live (ruling 8). Display: invoice UI + PDF line source reads "Quote #N" from the frozen column **unconditionally** (frozen-paper rule — test: delete the quote after finalize, the invoice still says Quote #N).
- [ ] Tests: wholesale substitution; live-until-finalize (edit quote row → new invoice reflects it; finalized invoice unchanged); surcharges apply over quote-priced operations; breaks + minimum-floor + setup-on-top semantics on quote rows (reusing the engine's behavior against quote-shaped fixtures).

## Task 7: Cross-entity §5.14 blocks

**Files:** the parts/customers/reference delete paths + their blocker lists; sweep-test updates; additions to existing suites.

- [ ] `deletePart` refuses when live quote lines reference it, naming the quotes (linked + Excel, the established blocker UI contract); `deleteReference("processStepCode")` picks up `QuotePrice.processStepCodeId` via the Task 1 registry (verify the generic blocker walk covers it, with a test); `deleteReference("endingStatement")` blocked by referencing quotes; `deleteCustomer` adds live quotes to its blocker list.
- [ ] Contact deletion is deliberately NOT blocked (spec §4.1) — test that a quote whose contact was deleted still reads/prints with a blank Attn block.
- [ ] Reference-links sweep + permissions sweep green.

## Task 8: `/quotes` UI — worklist + list + detail (ruling 11)

**Files:** `erp/src/app/quotes/page.tsx`, `Quotes.tsx`, `erp/src/app/quotes/[id]/page.tsx`, `QuoteDetail.tsx` (+ small components as needed).

- [ ] Worklist page: "Follow-up due" and "Expired" sections with counts and inline actions (open, bump-follow-up date picker, close-with-reason dialog); the full list below — search, filters, Excel export. §5.15 pick-lists; §5.16 disabled-with-reason on every gated control; remount-per-record (`key={id}`); no `.catch(() => {})` on fetches; the notes-pair clobber shape avoided (single-save form, not optimistic sibling PATCHes).
- [ ] Detail page: header form (dates with the auto-expiry default behavior, contact picker, RFQ, ending-statement picker, notes pair); lines grid with part-picker/free-text toggle, quoted-qty + unlimited, attach-part action; per-line price-rows grid with breaks (mirror the 5A part-prices grid UX); close/reopen with the linked-open-orders warning list rendered; delete with reason + blockers list + Excel; print button + documents/print history; HistoryPanel.
- [ ] `npm run test:e2e` (existing flows must stay green; the new quote flow lands in Task 11).

## Task 9: Order entry, order hub, part page surfaces

**Files:** the Phase 3 order entry components, the order hub sections, the part detail page.

- [ ] Entry: each line shows its resolved quote ("Quote #1006", latest-effective auto-pick) with a re-pick/unlink control fed by `/api/quotes/eligible`; drafts carry picks; the §5.16 rule for users without `orders.edit`.
- [ ] Hub: per-line quote reference in the overview/parts sections, linked to the quote page.
- [ ] Part page: active-quote indicator (in-date OPEN quote lines, latest-effective first, linked) — spec §4.2.
- [ ] `npm run test:e2e`.

## Task 10: The quote PDF, print route, `User.title` surfaces (rulings 12, 14)

**Files:** create `erp/src/server/pdf/quote.ts`, `api/quotes/[id]/print/route.ts`, `erp/tests/quote-pdf.test.ts`; modify the cert PDF builder, `erp/src/server/users.ts`, the admin users page.

- [ ] The PDF to the sample (spec §6 transcription): header/company block, right block (Effective/Expires/Terms/RFQ/phones), Attn block, `quote_intro_text`, lines (qty|Unlimited|blank, part identity live-or-text, each weight, total lbs, material), per-row price section in 5A vocabulary ("Setup charge … **Plus** / Price per <unit> … **Or** / Minimum charge"), break rows when present, **indicative amounts computed through the pure engine** (quoted qty + each-weight fed as a synthetic line; omitted when qty/weight unknown or unlimited) — no second pricing formula; ending statement, `quote_liability_text`, signature block (quotedBy displayName + title); pdfmake footer page numbers (code-rendered layout — the Phase 7 JSON-template limitation does not apply).
- [ ] Print route: render → `storeDocument` (kind `QUOTE`, owner `quoteId`) → respond; gated `quotes.view`; print history on the detail page; reprint returns stored bytes exactly (`Buffer.compare` on STORED bytes only; fresh renders content-pinned).
- [ ] `User.title`: admin users form field through `users.ts`'s audited update; the cert signature block gains the title line (closing Phase 4 ping #4) — cert PDF test updated; quote signature uses it.
- [ ] `npm run test:e2e`.

## Task 11: E2E flow, docs, final gates

**Files:** `erp/tests/e2e/quotes.spec.ts`; `docs/HANDOFF.md`; `CLAUDE.md` only if a standing convention changed; the execution ledger's `progress.md`.

- [ ] E2E: create an ending statement → create a quote (linked part + free-text line, price rows with a break) → print → order entry auto-links and shows "Quote #N" → ship → invoice shows the quote source → close the quote and see the linked-order warning → worklist sections show follow-up/expired correctly. Full suite green; dev-DB fixtures cleared.
- [ ] Docs: HANDOFF §4 current-phase state updated (the merge itself moves the narrative later); spec §15 amendment table verified in place; CLAUDE.md untouched unless a convention genuinely changed (the quote-links leaf joins the existing leaf enumeration if the architecture section needs it).
- [ ] All five gates green; then the whole-branch review → one fix wave → PR (attribution in the body).
