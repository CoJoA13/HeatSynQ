# Task 1 report — Schema, migrations, and every registration that keeps the gates green

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-10 · **Implementer:** Task 1 subagent

## What was built

**Schema (`prisma/schema.prisma`):**

- New models `Quote`, `QuoteLine`, `QuotePrice`, `QuotePriceBreak`, `EndingStatement` per spec §4.1, with `///` comments carrying the load-bearing rules (allocation-only `quoteNumber`; XOR line identity; no GL on quote rows; judged-at-link-time window; notes pair; immutable `customerId`; contact-not-blocked).
- Existing models: `OrderLine.quoteLineId String?` (+ relation + `@@index`), `InvoiceLine.sourceQuoteNumber Int?` (frozen-snapshot comment), `User.title String @default("")`, `StoredDocument.quoteId String?` (+ relation + `@@index`; kind→owner comment block extended with the Phase 6 entry).
- Enum additions: `DocumentKind.QUOTE`, `PriceSource.QUOTE` (both appended, matching the constants arrays' order contract).
- Back-relations: `Customer.quotes`, `CustomerContact.quotes`, `Part.quoteLines`, `ProcessStepCode.quotePrices`, `EndingStatement.quotes`, `QuoteLine.orderLines`, and the two NAMED User relations (`QuoteQuotedBy` / `QuoteClosedBy` — two FKs to one model).

**Migrations (TTY-less `migrate diff` workflow; diff output read in full, split by hand):**

- `20260810120000_quote_enum_values/` — ONLY the two `ALTER TYPE … ADD VALUE 'QUOTE'` statements, own directory per the settled precedent (Postgres refuses same-transaction use of a new enum value).
- `20260810120100_quoting/` — the five tables, four altered tables, indexes, three partial uniques, and `StoredDocument_kind_owner_check` DROPped and re-ADDed **restated whole**: read from its current definition in `20260808230100_accounts_receivable/migration.sql`; new arm `QUOTE ⇒ "quoteId" IS NOT NULL` with every other owner column null, and every existing arm now also asserts `"quoteId" IS NULL`. The SHIPPER arm's deliberate looseness on `orderId` preserved verbatim.
- Applied to BOTH databases (`erp` and `erp_test`); `npx prisma generate` run; `npx prisma migrate status` clean on both (32 migrations, "Database schema is up to date!" twice).

**Registrations:**

- `src/server/audit.ts` — `AuditableModel` gains `"quote"` and `"endingStatement"`; `SNAPSHOT_INCLUDE.quote` pulls the full lines → prices → breaks tree (live rows only, every collection `orderBy`'d with id tie-breaks — the issue-#24 rule — and contact/ending-statement/user/part/step-code names selected in); `SNAPSHOT_INCLUDE.endingStatement: undefined`; `SNAPSHOT_SELECT.storedDocument` gains `quoteId` ("every scalar except fileData").
- `src/server/settings.ts` — `quote_valid_days` (int 1–3650, default 30, group Dates), `quote_intro_text` (default = the sample's line, new group Quoting), `quote_liability_text` (default `""`, group Quoting). `quote_number_next` untouched — it already existed.
- `src/lib/invoice-constants.ts` — `PRICE_SOURCES` gains `"QUOTE"` (appended, matching the enum order) + label `"Quote"`, with a comment that the real display is the frozen `sourceQuoteNumber`.
- `src/server/documents.ts` — `AREA_FOR_KIND.QUOTE = "quotes"`; `DocumentOwner` QUOTE arm; `ownerColumns` QUOTE case + `quoteId` in the none-object and return type; `DocumentMeta`/`DOCUMENT_SELECT` gain `quoteId`; `documentFilename` QUOTE arm (`quote-<n>.pdf`, new trailing optional `quoteNumber` param) and `resolveDocumentFilename` QUOTE lookup — tsc forced all of these the moment the enum widened.
- `src/lib/reference-links.ts` — `ReferenceLinkModel` gains `"quote" | "quotePrice"`; `QUOTE_VIA_PRICE` helper (blocker presented as the QUOTE, whole-chain liveness: price row + line + quote all live); entries for `quotePrice.processStepCodeId → processStepCode` and `quote.endingStatementId → endingStatement`.
- `tests/partial-unique-sweep.test.ts` — documented `Quote.quoteNumber` exemption beside `Order.orderNumber`'s, same comment style (allocation-only, number-on-paper reasoning).
- `tests/reference-links-sweep.test.ts` — `kinds.add("endingStatement")` (temporary, see deviations), the two new FKs added to the pinned expected list in sorted position, and the local target-kind set extended.

**Tests:** new `tests/quotes.test.ts` (5 tests): full-tree create/read-back smoke; quoteNumber stays taken after soft-delete; the two live-rows-only partial uniques behave (refuse live duplicate, free on soft-delete); the CHECK's QUOTE arm accepts/refuses correctly including an existing arm's new `"quoteId" IS NULL` assertion. Ripple fixes: `tests/documents.test.ts` `base` literal gains `quoteId: null`; `tests/invoicing-schema.test.ts` DocumentKind pin gains `"QUOTE"`; the three `DocumentMeta` adapter literals in `src/app/api/certs/[id]/print/route.ts`, `src/app/api/shippers/[id]/print/route.ts` (×2), and `src/server/traveler.ts` gain `quoteId: null`.

## The eachWeight-scale finding

Spec §4.1 writes `QuoteLine.eachWeight Decimal? @db.Decimal(12, 4)`, but **`Part.eachWeight` is actually `@db.Decimal(10, 4)`** (schema line ~424; `InvoiceLine.eachWeight` matches it at `(10, 4)` too). Per the brief's instruction to check the Part model and mirror its actual scale, `QuoteLine.eachWeight` is **`Decimal(10, 4)`**, with a schema comment naming the mirror. The spec's `(12, 4)` appears to be a transcription of the unit-price scale; if the owner wants the wider scale it is a one-line migration later.

## What the sweeps demanded for the FK registrations

- **`QuotePrice.processStepCodeId`** — the reference-links sweep surfaced it the moment the schema FK existed (`processStepCode` is already a guarded target) and demanded a `REFERENCE_LINKS` entry; registered with the `QUOTE_VIA_PRICE` parent-via-child shape, which also makes `deleteReference("processStepCode")`'s generic blocker walk cover quotes with no further code (Task 7 verifies behaviorally).
- **`Quote.endingStatementId`** — the sweep only sees FKs targeting known kinds, and `endingStatement` is not a `ReferenceKind` until Task 2. Rather than pulling the full constants entry forward (see deviations), `"endingStatement"` was added as a bare `BlockerTarget` and to the sweep's kind set, which then demanded (and got) the registry entry.
- **`QuoteLine.partId`** — the sweeps demanded **nothing**: `Part` is not a reference kind or `BlockerTarget`, so the FK is invisible to the registry machinery by design. It is NOT registered; part-delete protection is `parts.ts`'s hand-built blocker list, which Task 7 extends with quote lines. Documented in the sweep's expected-list comment so the absence is a decision, not a gap.

## Deviations from the brief, and why

1. **`QuoteLine.eachWeight` is `Decimal(10, 4)`, not the spec's `(12, 4)`** — the brief's own instruction (mirror `Part.eachWeight`'s actual scale) overrides the spec text; finding above.
2. **`QuotePriceBreak` carries `@@unique([quotePriceId, threshold], where: "deletedAt" IS NULL)`** — the brief/plan enumerate only the QuotePrice and EndingStatement partial uniques, but spec §4.1 defines `QuotePriceBreak` as "the `PartPriceBreak` mirror", and `PartPriceBreak` carries exactly this partial unique (two live breaks at one threshold are nonsense, and the sweep's reasoning about non-deterministic snapshots applies). Taken as part of "mirror"; flagged here for the reviewer to confirm.
3. **`endingStatement` pulled forward as a bare `BlockerTarget`, not a `REFERENCE_KINDS` entry.** Adding it to `REFERENCE_KINDS` would have dragged most of Task 2 in behind tsc and the enumerating tests: the admin reference page grows a tab, `PICKLIST_KINDS` derives from it (picklist route starts serving the kind), `EXTRA_SCHEMAS`/`REFERENCE_EXTRA_FIELDS` need typed entries, and `tests/reference-tables.test.ts` pins the kind list — all live behavior, not registration. The bare-target route is the existing `processStepCode`/`surcharge` precedent, touches only `reference-links.ts` + the sweep, and satisfies exactly what the sweeps enforce. Comments at all three sites tell Task 2 to absorb the literal into `ReferenceKind` and delete the temporary pieces (`BlockerTarget` literal, `TARGET_LABELS` row, sweep's `kinds.add`).
4. **`QuoteLine.partId` has no registry entry** (above) — the brief listed it among the FK-registry entries, but the registry is structurally reference-kind-only; making `part` a `BlockerTarget` would force registering every Part-targeting FK in the schema (orderLine, partSpecification, partInspection, partPrice, …) and rewire `deletePart`, far beyond "registration only".
5. **`AuditableModel` also gains `"endingStatement"`** — not named by the brief, but `audit.ts` is Task 1's file and absent from Task 2's file list, and the generic reference machinery calls `audited*(kind)` typed against `AuditableModel`, so Task 2 would be blocked by tsc without it. Entry is `undefined` (no relations), the commentSnippet shape.
6. **Quote children are NOT separately registered in `AuditableModel`** — the brief said "follow the Order/Invoice precedent"; the quote's lines/prices/breaks are edited through the parent document (array-replace, per spec §5.1/plan Task 4), which is the Order shape — every mutation lands as the quote's own before/after diff via `SNAPSHOT_INCLUDE.quote`'s full tree. If Task 3/4 write children through their own `audited*` calls, each is a one-line addition then.
7. **`quote_valid_days` is `int(1, 3650)`**, not an uncapped positive int — it feeds date arithmetic, and `request_days_default`'s cap is the standing precedent for day-count settings.
8. **`Quote` carries `@@index([customerId])`** though spec §4.1 lists no Quote indexes — the house invariant (every customer-owned model indexes `customerId`: Order, Shipper, Invoice, Payment). No worklist-date indexes added; the table is small for years and Task 1 should not invent index needs Task 3 hasn't demonstrated.
9. **`tests/invoicing-schema.test.ts`'s DocumentKind pin updated** (not in the brief's file list) — it hard-codes the enum's member list and fails the moment the `ADD VALUE` lands; updating it is the registration keeping the gate green.
10. The smoke test goes slightly beyond the minimal "create and read back": it also pins the quoteNumber no-reuse contract, the two partial uniques, and the CHECK's QUOTE arm — all schema-only behavior this task created, in the style of `certs-schema.test.ts`/`invoicing-schema.test.ts`.

## Gate results

| Gate | Result |
|---|---|
| `npm test` | **126 files passed, 1952 tests passed, 0 failed** (was 125 files / 1947 tests before this task; +`tests/quotes.test.ts` ×5) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | ✓ Compiled successfully; 71/71 static pages generated |
| `npx prisma migrate status` | clean on `erp` AND `erp_test` (32 migrations each) |

E2E not run — no UI, function, or flow changed (brief: not required for this task; the data layer is inert until Task 3+ wires services).

## For the reviewer to scrutinize

- The restated CHECK in `20260810120100_quoting/migration.sql` against the previous definition in `20260808230100_accounts_receivable/migration.sql` — every arm restated, every prior arm gaining exactly `AND "quoteId" IS NULL`, SHIPPER arm's looseness untouched.
- Deviations 2 (break partial unique), 3/4 (the endingStatement/partId registry calls), and 6 (children not separately auditable) — each is a judgment call the brief's wording left open.
- `SNAPSHOT_INCLUDE.quote`'s live-rows filtering (`where: { deletedAt: null }` on lines/prices/breaks): follows the `partPrice` precedent, but it does mean a line soft-deleted through a future edit path shows as removal-by-omission in the parent diff, same as part prices today.
- The `ON DELETE SET NULL` on `OrderLine_quoteLineId_fkey` is Prisma's default for optional relations (the `StoredDocument.customerId` precedent) — inert under soft-delete-only, and the schema comment documents the §5.14 block as the real guard.
