# Phase 6 — Quoting: Design Specification

**Date:** 2026-08-10
**Status:** Approved by owner 2026-08-10, including the seven precedent-based calls flagged at review (notes pair; close/reopen under `quotes.edit`; delete-with-reason + §5.14 block; immutable `customerId`; empty linked quote = needs-price; contact delete not blocked; no attachments). §3 records every ruling taken in the design session
**Branch:** `phase-6-quoting`
**Supersedes, in part:** spec §7.7 (Quoting), the Quote row of §5.1, and §7.5 tier 1's "referenced on the order" wording (the reference is per order line — §3 ruling 5)
**Depends on:** Phase 5A (`PartPrice`/`PartPriceBreak`, the pure `pricing.ts` engine and its `PriceRowInput` contract, the frozen-invoice snapshot rule, `allocateNumber`), Phase 3 (the one-transaction order save, order drafts, the order hub), Phase 2A (the reference-kind machinery, the §5.14 delete-blocker registry), Phase 4 (`StoredDocument` + the kind→owner CHECK, the PDF render path)
**Build target for the PDF:** `docs/samples/Quote_Sample_Form.jpeg` (owner-supplied 2026-08-10 — Visual Shop's stock quote form; §6 transcribes it)

---

## 1. Goal

Build the quoting module the roadmap's Phase 6 promises: **customer quotes with part/price lines in 5A's own price vocabulary, a follow-up/expired worklist, and the quote → order linkage that makes §7.5's pricing tier 1 live.** A quote is a **standing price agreement** (§3 ruling 3): born numbered and OPEN, effective over a date window, pricing every order entered inside that window, closed or reopened only by a deliberate reasoned act. Order entry auto-links each line's part to its active quote; invoicing prices linked lines from the quote's rows instead of the part's, and every such invoice line names its quote number. The quote PDF is the **eighth document type**, rendered to the owner's sample and stored byte-for-byte.

Testable outcome (roadmap): **quote real work** — key a quote, print it, watch an order pull its pricing through to a finalized invoice that says "Quote #N".

## 2. Scope

**In:** the `Quote`/`QuoteLine`/`QuotePrice`/`QuotePriceBreak` model (§4); quote entry (part-linked and free-text lines, price rows mirroring part prices, breaks included); the standing-agreement lifecycle with close/reopen-with-reason; the `/quotes` worklist page (follow-up due + expired sections above the searchable list, Excel export); per-order-line auto-link at order save with the latest-effective-wins rule, overridable at entry; tier-1 resolution in invoice assembly (quote rows substitute wholesale, `priceSource = QUOTE`, quote number frozen onto the invoice line); the quote PDF + `QUOTE` `DocumentKind` with print history; quote numbering from the existing `quote_number_next` counter; the **`endingStatement` reference kind** (eleventh kind, with per-quote pick and a default — §3 ruling 13); **`User.title`** (prints on the quote signature block and closes Phase 4's cert-signature ping — §3 ruling 14); the part page's active-quote indicator; `quotes`-area permissions on every route.

**Out (deliberate, revisit only by owner ruling):** prospect/lead customers (a quote requires a real customer — ruling 1); quote attachments (VS has a paperclip on quotations; nothing in §7.7 or the owner session asked for it — add later if wanted); automatic emailing of quotes (spec §3 non-goal); quote revisions/versioning (edits are audited in place — ruling 8; a renegotiation that must preserve the old paper is simply a new quote); structured close outcomes (free-text reason only — ruling 10); conversion/follow-up **reports** (Phase 8; the worklist is the Phase 6 deliverable); per-customer quote template variants and the template designer (Phase 7); VS's presentational "Multi Quote #" combining (one HeatSynQ quote already holds many parts).

## 3. Owner decisions, 2026-08-10 (this design session)

| # | Decision | Ruling |
|---|---|---|
| 1 | Quote scope | **Real customer required; part optional per line.** A quote line either references a memorized part (participates in auto-link + tier 1) or is free-text part number/name/description — paper-only until a part is attached to it later (an audited `quotes.edit` action). No prospect/lead customers |
| 2 | Price-row shape | **Exact mirror of `PartPrice`, breaks included**: per Process Step Code — setup charge / unit price / minimum charge, price-per (EACH/LB/PER_100/PER_1000/LOT), plus quantity-or-weight breaks. (VS quote rows carry the same minus breaks; the sample's "Furnace Charge $2.00 **Plus** / Price per Each $0.15 **Or** / Minimum Charge $100.00" is exactly ruling 13's setup-on-top / minimum-as-floor semantics) |
| 3 | Lifecycle | **Standing agreement.** Born OPEN with its number allocated at creation; editable (audited) while open; prices ANY number of orders entered in its window. Linking never closes it; close/reopen are deliberate reasoned acts; "expired" is **derived** from the expiry date, never a status flip |
| 4 | Tier interaction | **Quote wins wholesale per order line.** A linked line prices from the quote's rows ONLY — the part's rows are ignored entirely for that line; a step the quote doesn't carry doesn't bill. (VS: "all price rows come from the structure.") Never merges per step code |
| 5 | Link granularity | **Per order line**: each order line stores which quote line prices it. Two parts on one order can sit on different quotes. Supersedes §7.5's "referenced on the order" wording — record in spec §15 |
| 6 | In-date rule | **Judged at link time.** To be linked (auto or manual), a quote must be OPEN and in-date against the order's **received date**. Once linked, the stored link prices the order through shipping and invoicing — later expiry or closure never silently re-prices it. Closing a quote that open orders still link to **warns and lists those orders** (§5.14 discoverability); unlinking is a deliberate order-side edit |
| 7 | Auto-link ambiguity | **Latest effective date wins silently** (tie → higher quote number) when several open in-date quotes cover the same customer + part. Always overridable at entry: re-pick another eligible quote or unlink (line falls to part prices). Saving a quote that overlaps an existing open quote for the same part **warns but doesn't block** |
| 8 | Quote edits vs linked orders | **Live until finalize.** Invoices resolve the quote's rows at invoice-creation time, exactly as part prices resolve today; an edit is the renegotiated standing agreement. Finalized invoices stay frozen paper. No snapshot-at-link layer |
| 9 | Extra fields | **All four**: RFQ number (free text, prints); customer contact (picked from the customer's contacts, prints in the Attn block); quoted qty per line (informational "based on N pcs" / unlimited — brackets remain the breaks' job); auto-expiry default (`quote_valid_days` setting pre-fills expiry from the quote date, editable per quote) |
| 10 | Close reason | **Free text only** (the house void/close pattern). Conversion stays derivable from order links; no outcome taxonomy |
| 11 | Worklist | **Two worklist sections + list**: `/quotes` leads with "Follow-up due" and "Expired" (each with a count and inline open / bump-follow-up / close-with-reason actions), the full searchable/filterable quote list with Excel export below. The house list pattern, not the order board's saved-views machinery |
| 12 | PDF build target | **Owner-supplied sample** — `docs/samples/Quote_Sample_Form.jpeg`, dropped 2026-08-10. §6 transcribes it; deviations surface at the demo |
| 13 | Ending statement | **Build the missing `endingStatement` reference kind** (VS-style): admin-maintained list with one default; each quote may pick a different one (or none); the settings liability block still prints beneath. The eleventh reference kind — §5.1's reference-data row listed it, Phase 2A shipped without it, the quote is the first document that needs it |
| 14 | Signature title | **Add `User.title` now.** The quote prints the quoter's name + title per the sample, and the cert signature block gains its missing title line in the same stroke — closing Phase 4 open ping #4 (HANDOFF §7.5.4). Blank title prints nothing |

## 4. Data model

### 4.1 New tables

- **`Quote`** — `quoteNumber Int @unique` (allocated from the existing `quote_number_next` counter inside the create transaction; **plain unique, allocation-only** — a deleted quote keeps its number forever, the `Order.orderNumber` precedent, with a documented sweep exemption). `customerId → Customer` (**immutable after create** — the agreement's identity; a wrong customer is delete-and-recreate, which the §5.14 block keeps honest). `contactId → CustomerContact?` (nullable; live-join on read, renders blank if the contact is later deleted — not blocked, the quote's stored PDFs keep the printed name). `status String` (`OPEN` ↔ `CLOSED`), `closeReason String @default("")`, `closedAt DateTime?`, `closedById → User?`. `quoteDate`, `effectiveDate`, `expiryDate` (all `@db.Date`; entry defaults: today / quoteDate / quoteDate + `quote_valid_days`), `followUpDate DateTime? @db.Date`. `rfqNumber String @default("")`. `quotedById → User` (defaults to the creator; the signature block). `endingStatementId → EndingStatement?` (defaulted to the kind's default row at creation, editable, nullable = none prints). `notes String @default("")` (prints) + `internalNotes String @default("")` (never prints — the cert notes-pair precedent). `deletedAt`, timestamps. Relations: `lines`, `documents`.
- **`QuoteLine`** — `quoteId`, `position Int`, `partId → Part?` (nullable — ruling 1). Free-text identity used **only when `partId` is null**: `partNumberText`/`partNameText`/`partDescriptionText String @default("")`, `materialText String @default("")`, `eachWeight Decimal? @db.Decimal(12, 4)` (display + indicative math; part-linked lines read all of these live from the part). `quotedQty Int?` + `quotedUnlimited Boolean @default(false)` (ruling 9 — informational). `deletedAt`, timestamps. Service rules: a line carries `partId` XOR a non-empty `partNumberText`; one live line per part per quote; **attaching a part to a free-text line** sets `partId` (audited — from then on it auto-links). `@@index([quoteId])`, `@@index([partId])`.
- **`QuotePrice`** — the `PartPrice` mirror, parented on the quote line: `quoteLineId`, `processStepCodeId → ProcessStepCode` (required), `position Int`, `setupCharge Decimal? @db.Decimal(12, 2)`, `unitPrice Decimal? @db.Decimal(12, 4)`, `minimumCharge Decimal? @db.Decimal(12, 2)`, `pricePer PricePer @default(EACH)`, `notes String @default("")` (the sample's per-row "Quote Notes" line — prints under the step name), `breaks QuotePriceBreak[]`, `deletedAt`, timestamps. `@@unique([quoteLineId, processStepCodeId], where: raw("\"deletedAt\" IS NULL"))` (the `PartPrice` partial-unique precedent). **No GL columns** — GL is internal, resolved live from the step code at invoice assembly exactly as part-price rows resolve it; a customer's quote paper never carries account numbers.
- **`QuotePriceBreak`** — the `PartPriceBreak` mirror: `quotePriceId`, `threshold Decimal @db.Decimal(12, 2)` (in the parent row's price-per unit), `price Decimal @db.Decimal(12, 4)`, `deletedAt`, timestamps. LOT rows refuse breaks (the part-prices rule).
- **`EndingStatement`** — the eleventh reference kind, standard shape (`id`/`name`/`active`/`deletedAt`, partial-unique `name`) plus extra columns `text String` (max 4000, the statement body — the `commentSnippet.text` precedent) and `isDefault Boolean @default(false)` (service-normalized to at most one live default — the address-default precedent). Wired through `REFERENCE_KINDS`, `REFERENCE_LABELS`, `EXTRA_SCHEMAS`, the extra-columns UI config, `PICKLIST_KINDS` (quote entry reads it via `/api/picklists`), and the §5.14 blocker registry.

### 4.2 Changes to existing models

| Model | Change |
|---|---|
| `OrderLine` | **gains `quoteLineId String?`** → `QuoteLine` (nullable FK + index) — the per-line link (ruling 5). Plain live reference: quotes only soft-delete, and §5.5 blocks deleting a quote (or a quote line) any order line references, so the FK never dangles |
| `InvoiceLine` | **gains `sourceQuoteNumber Int?`** — frozen snapshot, written when `priceSource = QUOTE`, read **unconditionally** (the invoice-is-frozen-paper rule): §7.5 says every line names its source, and a later quote delete must never blank sent paper |
| `PriceSource` (DB enum) | **gains `QUOTE`** (`ADD VALUE` — own earlier migration directory, §9). `PRICE_SOURCES`/labels in `invoice-constants.ts` gain it too |
| `DocumentKind` (DB enum) | **gains `QUOTE`** (`ADD VALUE` — same earlier migration directory) |
| `StoredDocument` | **gains `quoteId String?`** → `Quote` + index; the hand-written kind→owner CHECK is DROPped and re-ADDed whole with a new arm — `QUOTE` requires `quoteId` alone, every other owner column null — and every existing arm now also asserts `quoteId IS NULL` (the CHECK's restate-whole convention) |
| `User` | **gains `title String @default("")`** (ruling 14) — admin user form field; prints on the quote signature block and the cert signature block (cert render gains the line in this phase) |
| `Part` | back-relation `quoteLines QuoteLine[]`; the part detail page gains an **active-quote indicator** (the in-date OPEN quote line(s) for this part, latest-effective first, linked). `QuoteLine.partId` and `QuotePrice.processStepCodeId` register in the §5.14 FK/blocker registries, so deleting a part or a step code that quotes reference is refused-and-named |
| `Customer` | back-relation `quotes Quote[]`; `deleteCustomer` adds quotes to its blocker list (a customer with quotes is refused-and-named) |

Engine contract (`pricing.ts`): `PriceRowInput` gains optional `priceSource` and `sourceQuoteNumber` pass-throughs (defaulting `PART_PRICE`/null so every existing caller is untouched); `priceOrder` stops hardcoding `priceSource: "PART_PRICE"` and emits what the row carries. Pure and additive — no math changes.

## 5. Module behavior

### 5.1 Quote lifecycle

- **Create** (`quotes.create`): one transaction — `allocateNumber("quote_number_next", tx)`, header + lines + price rows written through the audit helpers (`Quote` joins `AuditableModel`; `SNAPSHOT_INCLUDE` pulls lines → prices → breaks so join-table edits show in history). Entry defaults: quoteDate today, effective = quoteDate, expiry = quoteDate + `quote_valid_days` (new int setting), ending statement = the kind's default row, quotedBy = the actor.
- **Edit** (`quotes.edit`, OPEN only): header fields, lines, and price rows — audited, effective immediately for future invoicing (ruling 8). `customerId` is immutable. Changing a **linked** quote line's `partId`, or deleting a quote line (or the whole quote) that any order line references, is **refused and the blockers named** (§5.14 — with the Excel export the other blocked deletes have): a vanished or re-pointed line would silently re-price the order, which is the exact failure §7.5 exists to prevent. Invoice assembly additionally asserts `quoteLine.partId === orderLine.partId` as a belt-and-braces invariant (a mismatch is a bug, not an expected failure).
- **Close / reopen** (`quotes.edit`): reasoned (trimmed non-empty, enforced in the service), audited, no new special action — closing a quote is reversible and takes nothing with it, unlike the §9 dangerous-action list. The close **response lists the open, not-yet-fully-invoiced orders still linked** (ruling 6's warn-and-list); the UI shows them with links. A CLOSED quote: stops auto-linking and stops being manually linkable; existing links keep pricing.
- **Expiry** is derived: `expiryDate < today` with status OPEN renders as "Expired" everywhere and feeds the worklist; no status flip, no job.
- **Delete** (`quotes.delete`): soft, **reason required** (§5.17 — it carries its lines and price rows away), **refused-and-named** while any order line references any of its lines (§5.14). A quote nothing ever linked — the typo case — deletes cleanly; its number is never reused.

### 5.2 Auto-link and the order side

- **Eligibility** (one rule, used everywhere): quote `OPEN`, live, same customer as the order, quote line's `partId` = the order line's part, and `effectiveDate ≤ order.receivedDate ≤ expiryDate`. Free-text lines are never eligible until a part is attached.
- **At order save** (create and `addLine`): each line resolves its eligible quote lines; **latest effective date wins, tie → higher quote number** (ruling 7), stored on `OrderLine.quoteLineId`. The entry UI shows the resolution before save and offers re-pick/unlink; the save payload can carry an explicit `quoteLineId` (validated against the same eligibility rule) or an explicit null (no link); a payload that doesn't specify gets the server's auto-resolution — so API callers and the idempotent replay behave identically. Order drafts carry the picks.
- **After save**: the link is judged at link time (ruling 6) — editing the order's received date does not re-judge stored links; the re-pick UI re-validates against the current received date when the user touches it. Swapping an order line's part clears and re-resolves its link. Links ride through shipping, invoicing, unlock-and-recalculate (which re-reads the linked quote's rows live — the correction path working as designed), and reversal untouched.
- **Display**: the order entry form and the order hub show each line's quote number ("Quote #1006") with a link; the part page shows its active quote (§4.2).

### 5.3 Tier-1 resolution (invoice assembly)

Where invoice assembly today builds each order line's `PriceRowInput[]` from `listPartPrices(ol.partId)`: if the line carries a live `quoteLineId`, build the rows from that quote line's live `QuotePrice`/`QuotePriceBreak` rows instead — **wholesale** (ruling 4) — with `priceSource: "QUOTE"`, `sourceQuoteNumber: quote.quoteNumber`, and GL resolved from each row's step code the same way part-price assembly resolves it. No link (or a link whose quote line has no rows) falls through to tier 2/tier 3 exactly as today; a linked line with zero quote rows is tier 3's needs-price, not a silent part-price fallback — the link declared the agreement, and an empty agreement is a flag, not permission to bill something else. The engine's needs-price, minimum-floor, setup-on-top, and break-selection semantics apply to quote rows unchanged. Invoice line display and the invoice PDF name the source: "Quote #1006" (§7.5's "every line names its source" — the frozen `sourceQuoteNumber`).

Surcharges are unchanged: they key off step codes and apply to quote-priced operations exactly as to part-priced ones (per-customer opt-out/override already governs).

### 5.4 The worklist (`/quotes`)

Ruling 11's shape: two sections with counts above the list —

- **Follow-up due**: OPEN, live, `followUpDate ≤ today`.
- **Expired**: OPEN, live, `expiryDate < today`. (A quote can appear in both; that is information, not a bug.)

Inline actions: open the quote; **bump follow-up** (date picker, `quotes.edit`, audited); **close with reason** (§5.1). Below: the full quote list — search (number, customer, RFQ, part number), filters (status incl. derived Expired, customer, date range), Excel export — the house list pattern (§5.15 pick-lists via `/api/picklists`, §5.16 disabled-with-reason controls, no saved-views machinery).

## 6. The quote PDF (eighth document type)

Build target: `docs/samples/Quote_Sample_Form.jpeg` (ruling 12), rendered server-side through the existing `renderPdf` path and stored byte-for-byte (`StoredDocument`, kind `QUOTE`, `quoteId` owner; print history on the quote page; reprint returns the stored bytes exactly). Print requires `quotes.view` (the documents API already gates per kind via `AREA_FOR_KIND`; `QUOTE → "quotes"`).

Layout, transcribed from the sample:

- **Header**: "Quotation" title; company name/address/phone/fax (settings); "Quotation Number: N"; "Page: N of M" (the quote render is code, not a Phase 7 JSON template, so a pdfmake footer page function is available — the shipping-ticket limitation does not apply here).
- **Right block**: Effective / Expires On / Terms (the customer's terms name); "Your R.F.Q. Number"; the customer's phone/fax where the model has them.
- **Attn block**: contact name (when picked), customer name, bill-to address (the invoice's address-resolution precedent).
- **Intro line**: "We are pleased to provide you with the following quotation:" — a new settings text block (`quote_intro_text`), seeded with the sample's wording.
- **Lines**: quantity (quotedQty or "Unlimited", blank when neither), part number / name / description, each weight, total lbs (qty × each-weight when both known), material — live from the part for linked lines, the line's own text fields for free-text lines.
- **Price section per line**, per price row: step name + row notes, then the 5A vocabulary in the sample's own arrangement — "Setup charge: $X **Plus**", "Price per <unit>: $Y **Or**", "Minimum charge: $Z" — with break rows listed when present, and an **indicative extended amount** at the right computed through the pure engine when a quoted qty (and weight, for LB rows) is known; omitted for unlimited/no-qty lines. The engine's real math is the display's only source — no second pricing formula.
- **Footer**: the quote's ending statement text (ruling 13); a `quote_liability_text` settings block (empty default — the owner keys the shop's limited-liability wording); signature block: quotedBy's display name + `User.title` (ruling 14).

The sample is VS's stock vendor form filled with vendor demo data — the layout is the target, its demo content is not; deviations surface at the demo (the Phase 5A precedent).

## 7. Permissions, audit, and house rules

- **Area**: `quotes` (already in `permission-constants.ts`) — view/create/edit/delete on every route; `Shell.tsx`'s existing nav entry lights up. No new special action (§5.1). The permissions sweep picks the routes up automatically.
- **Audit**: every mutation through the audit helpers; `Quote` (with lines/prices/breaks in `SNAPSHOT_INCLUDE`), `EndingStatement` via the generic reference machinery, `User.title` via the existing user update path. HistoryPanel on the quote page.
- **§5.14**: quote-delete and quote-line-delete blockers name their orders (with Excel export); `QuoteLine.partId`, `QuotePrice.processStepCodeId`, `Quote.endingStatementId` join the FK/blocker registries (the sweep test enforces registration).
- **§5.16**: disabled-with-tooltip on every gated control; **§5.15**: entry pick-lists (parts, contacts, step codes, ending statements) readable with a session via `/api/picklists`.
- **Sweeps**: `Quote.quoteNumber` gets the documented allocation-only exemption beside `Order.orderNumber`; `EndingStatement.name` and `QuotePrice`'s composite get partial-unique treatment; no `findUnique` on live-rows-only columns.
- **Concurrency**: quote mutations claim their own row (`SELECT … FOR UPDATE`) before acting; invoice assembly reads quote rows inside its existing Serializable transaction, which SSI protects against concurrent quote edits the same way it protects part-price reads today (the #60 lesson: read them on the transaction's own client, inside the snapshot). No multi-order claims are added — quote mutations never touch orders (close only *reads* linked orders to warn).

## 8. Settings

New keys (typed, validated, existing groups): `quote_valid_days` (int, default 30 — ruling 9), `quote_intro_text` (seeded with the sample's line), `quote_liability_text` (default empty). `quote_number_next` already exists (seeded Phase 1) — Phase 6 only wires `allocateNumber` to it.

## 9. Migrations (the settled two-step shape)

1. `<ts>_quote_enum_values/` — `ALTER TYPE "DocumentKind" ADD VALUE 'QUOTE'; ALTER TYPE "PriceSource" ADD VALUE 'QUOTE';` — its **own earlier directory** (Postgres refuses to use a new enum value in the transaction that added it; `migrate deploy` runs one directory per transaction).
2. `<ts>_quoting/` — the four quote tables, `EndingStatement`, `OrderLine.quoteLineId`, `InvoiceLine.sourceQuoteNumber`, `User.title`, `StoredDocument.quoteId` + the CHECK DROP/re-ADD (every arm restated, every arm asserting `quoteId IS NULL` except the new `QUOTE` arm), indexes and partial uniques.

Hand-written via `migrate diff` (the TTY-less workflow), applied to **both** databases, `prisma generate` after.

## 10. Testing

TDD per task, the usual gates. The rules that must each have a failing-first test: number allocation (concurrent creates); the eligibility rule at every edge (closed, expired, wrong customer, free-text, received-date boundaries **inclusive**); latest-effective-wins + the tie-break; explicit-pick validation and explicit-null; link survival across received-date edits, quote close, quote expiry; the close warning's order list; §5.14 blocks (quote delete, line delete, part delete, step-code delete, customer delete) each naming blockers; wholesale substitution (a quote row set replaces the part's entirely; empty quote rows = needs-price, **not** part-price fallback); `sourceQuoteNumber` frozen on the invoice line and surviving quote deletion; live-until-finalize (edit quote → invoice reflects it; finalized invoice doesn't); the ending-statement default normalization; the worklist queries' boundaries; the PDF (content-pinned, not byte-compared — `renderPdf` is not byte-deterministic; stored-byte reprint stays `Buffer.compare`); the partial-unique and permissions sweeps extended. E2E: a full quote flow (create → print → order auto-link → invoice shows "Quote #N") joins the Playwright suite, and the whole suite runs on any UI-touching change (standing owner rule).

## 11. Spec §15 amendments to record on approval

- §7.5 tier 1 / §7.7: the quote reference is **per order line** (ruling 5); tier 1 substitutes **wholesale** (ruling 4); validity is judged **at link time against the order's received date** (ruling 6); auto-link resolves **latest-effective-wins** (ruling 7); quote edits price **live until finalize** (ruling 8).
- §5.1 reference data: **ending statements** built as the eleventh reference kind (ruling 13 — listed in the original spec, shipped late).
- §9/§4: `User.title` added (ruling 14 — also closes Phase 4 ping #4, the cert signature title).
- §5.1 Quote row: superseded by this spec's §4.

## 12. Open items

None blocking. The demo reviews the PDF against the sample (the deviations channel), and HANDOFF §7's owner-homework list (GL list, bookkeeper QBO method, report list) is untouched by this phase.
