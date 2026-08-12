# Task 10 report — The quote PDF, print route, documents route, `User.title` surfaces (rulings 12, 14)

**Phase:** 6 (Quoting) · **Branch:** `phase-6-quoting` · **Date:** 2026-08-11 · **Implementer:** Task 10 subagent

## What was built

Four commits, TDD per piece (failing test → implement → green → commit). The fourth (`39cf88a`)
is a builder fix that was made during the gate run but missed its `git add` — the `labelled`
helper spread a `Content` union (TS2698); it now takes a `topMargin` parameter instead. Every
gate ran against the fixed tree; the committed-but-broken window existed only inside this task's
own branch history. Caught by the controller's tree check between turns; gates rerun after the
commit.

1. **`16f817c`** — the eighth document type end-to-end on the server:
   - **`erp/src/server/pdf/quote.ts`** — the pure builder (`QuotePdfData` in, `TDocumentDefinitions`
     out; no I/O, no clock, no Prisma rows — the invoice/cert builder contract). One deliberate
     departure from the siblings: the definition carries a **footer page callback** ("Page: N of M"
     on every page) — spec §6's explicit carve-out ("the quote render is code, not a Phase 7 JSON
     template"), so there is no JSON-round-trip purity test for this builder; the callback's own
     output is content-pinned instead (`def.footer(2, 5)` → "Page: 2 of 5").
   - **`quotes.ts` print section** — `quotePrintSettings()` (company block + `quote_intro_text` +
     `quote_liability_text`, read OUTSIDE the transaction — the cert/ticket/invoice pool-starvation
     rule), `readQuotePdfData(db, id, settings?)` (the collector, on the caller's claim-holding
     `tx`), and `printQuote(id)`: `claimQuote` → `assertPrintable` → read → render →
     `storeDocument(tx, { kind: "QUOTE", quoteId }, pdf)` in ONE Serializable transaction (the
     `printInvoice` shape — the archive cannot commit against a state a concurrent delete changed
     out from under it).
   - **Indicative amounts through the REAL engine**: `indicativeAmounts` builds each quote line's
     `PriceRowInput[]` (rows + breaks, GL null — a customer paper never carries accounts) and feeds
     `priceOrder` ONE synthetic line (`shippedQty = quotedQty`, `shippedWeight = quotedQty ×
     each-weight`), then reads the amounts back off the computed OPERATION lines in order (the
     engine's own one-OPERATION-per-row contract). No second pricing formula exists anywhere in the
     new code — minimum-floor, setup-on-top and break selection are all the engine's. Amounts are
     `null` (omitted on paper) when the line is unlimited or has no quoted qty, and per-row when an
     LB row's each-weight is unknown (its basis is unknown; a 0-weight extension would print the
     minimum as if it were the real charge).
   - **`documents.ts`** — `listDocumentsForQuote` (the `listDocumentsForInvoice`/`ForCert` shape:
     `quoteId` is a column only `QUOTE` populates, so no union/kind filter; unknown quote 404s; a
     deleted quote's prints stay listable forever, §5.6).
   - **`POST /api/quotes/[id]/print`** and **`GET /api/quotes/[id]/documents`** (the Task 8 path
     contract, closed) — precedents cited below.
   - **`erp/tests/quote-pdf.test.ts`** — 25 tests (builder content pins, collector + engine cases,
     print/archive/reprint, both routes).
2. **`cd2c598`** — `User.title` server-side + the cert signature line (closing Phase 4 ping #4):
   `users.ts` (`listUsers` returns it, `updateUser` patches it through the audited update),
   `audit.ts` (`SNAPSHOT_SELECT.user` gains `title` — without it a title change would diff as no
   change at all), the admin `PUT` route body, `certs.ts` (`CertSignerRow` gains `title`,
   `printCert` selects it, `readCertPdfData` passes it — the cert BUILDER already rendered a
   non-empty title since Phase 4; the collector's hardcoded `""` was the whole gap). Tests:
   `users.test.ts` +1 (update/list/audit-diff), `cert-pdf.test.ts` +2 (builder prints/omits;
   the real print path carries the user's title) — **extended, not rewritten**; every existing
   cert test passes untouched.
3. **`e45e346`** — the UI: `QuoteDetail.tsx`'s Print button comes alive (the `InvoiceDetail`
   `printInvoice` handler shape: POST → blob → new tab, `opener` nulled, object-URL revoked,
   documents list bumped via a `refresh` counter; pop-up-blocked case reported with "the document
   was archived"), `printGate` = deleted ? disabled-with-reason : `quotes.view` (§5.16),
   `QuoteDocumentsList` gains `refresh` and drops its 404→empty-state special case (the route now
   exists; a failure is an error again), and the admin users page gains a **Title** column
   (per-row input, PATCH-on-blur only when changed — a keystroke-level PATCH would mint an audit
   entry per character; keyed remount re-baselines after each reload).

## Precedents mirrored (the brief's citation requirement)

- **Print route**: `POST`, gated **`quotes.view`** — the traveler
  (`api/orders/[id]/traveler`), cert (`api/certs/[id]/print`) and invoice (`api/invoices/[id]/print`)
  routes all gate print on the area's **view** permission with the same stated reasoning, restated
  in the new route's comment: a print changes nothing about the quote beyond the audited archive of
  its own output — a read of the document, as an explicit POST so §12's "reads never mutate" holds.
  Response shape mirrored too: PDF bytes, `content-disposition: inline; filename="quote-N.pdf"`,
  `x-document-id` header. The filename is built the **cert route's** way (`documentFilename` with
  the number `printQuote` already returns) rather than the invoice route's
  `resolveDocumentFilename` detour — the invoice route needs that only because its document number
  carries a prefix the print result doesn't return.
- **Print service**: `printInvoice`/`printCert` — settings outside the transaction, claim →
  `assertPrintable` → read-on-tx → render → `storeDocument`, all in one Serializable transaction.
  Unlike the cert there is no `printedAt` equivalent (that is a cert-specific §5.16 gate); print
  history is the stored-documents list itself.
- **Documents route**: `GET /api/invoices/[id]/documents` / `GET /api/certs/[id]/documents` —
  including the permission reasoning about `AREA_FOR_KIND`: the only kind `listDocumentsForQuote`
  can return sits behind the SAME `quotes` area the route gates on, so no per-kind viewer
  filtering is needed the way the order hub's cross-kind union needs it.
- **Collector**: `readCertPdfData`/`readInvoicePdfData` — runs on the caller's `db` (the claim-
  holding `tx` inside the print), bill-to resolved via `listAddresses` + the invoice's
  `pickDefault` shape.
- **UI print handler**: `InvoiceDetail.tsx`'s `printInvoice` (itself the `ShipmentDetail`
  `printDoc` shape), and its `printGate`/`docsGate`/refresh-counter documents list.

## The deleted-quote print decision

**Mirrors the discarded-invoice precedent exactly**: a soft-deleted quote refuses a NEW print with
the shared `VOIDED_PRINT` 400 (`assertPrintable`, read under the quote-row claim), while every
STORED print stays listable (`listDocumentsForQuote` never filters the owner's `deletedAt`) and
byte-exact downloadable forever (§5.6's voided-owner rule). A **CLOSED or expired quote prints
fine** — closing forbids edits, not the paper of the agreement it records (tested). The UI gate
says "Quote is deleted — nothing to print".

## Layout deviations from the sample (for the demo)

The sample is VS's stock vendor form with demo content; the layout is the target (spec §6). Every
deviation is also commented in `pdf/quote.ts`'s header:

1. **"Page: N of M" prints bottom-right** (the footer page callback), not the sample's top-right —
   the plan names "pdfmake footer page numbers", and the footer keeps the count on every page of a
   wrapped quote without margin games in the header band. It IS a real page count (the callback the
   pure-JSON documents couldn't carry).
2. **5A price vocabulary replaces the VS labels** (spec §6's own instruction): "Setup charge: $2.00
   Plus / Price per Each: $0.15 Or / Minimum charge: $100.00" where the sample reads "Furnace
   Charge / Price per Each / Minimum Charge", and "Price per Lot (flat): $20.00" where it reads
   "Flat rate charge of". Sample arrangement (setup first, amount at the right) kept.
3. **The sample's Bake row shows $100.00; ours would show $102.00** for the same numbers — ruling
   13's setup-ON-TOP semantics (max(15, 100) + 2), which the engine owns and the spec §3.2 note
   explicitly maps onto this sample. The engine's math is the only math.
4. **No fax lines** (vendor "Fax:" and customer "Your Fax No.:") — no fax field exists anywhere in
   the model (settings or contact); do-not-invent-fields, the invoice's and cert's identical
   deviation. "Your Phone No." prints from the picked contact's `phone`; the top "Phone:" is the
   company's own (settings), in the sample's position at the head of the right block.
5. **Attn block prints contact name, customer name, bill-to address** — the sample's extra
   "Supervisor" / "Jane's Department" lines are the VS contact's title/department, fields this
   model doesn't carry. A bill-to address row named differently from the customer prints its name
   ABOVE the customer name (the sample's own department-over-company stacking); otherwise the
   invoice's `renderAddress` resolution shape applies (blank components drop).
6. **The quote's printable `notes` print between the ending statement and the liability text** —
   §4.1 says notes print, §6 doesn't place them; the sample's own left-hand lines under the ending
   statement ("Our terms are net 30") sit exactly there.
7. **Unit and break prices print at up to 4 decimals** (`money4`: "$0.055" survives) where the
   invoice's `money` would round to cents — a quote's 4-decimal `Decimal(12, 4)` price IS the
   agreement; rounding it would misstate it. Amounts/setup/minimum stay 2-decimal `money`.
8. **Break rows print as centered "500 or more: $0.12" lines** beneath the price details — the
   sample carries no breaks (VS quote rows don't have them; ruling 2 added them), so there was no
   sample shape to follow; the threshold prints in the row's own basis unit (the engine's
   breakBasis rule).
9. **"Unlimited" prints in the Quantity cell**; a no-qty line prints blank (ruling 9). Price
   DETAILS still print for both — an unlimited agreement still states its prices; only the
   indicative extended amount is omitted.

## The cert-signature change's shape

The cert builder (`pdf/cert.ts` `signatureBlock`) has rendered `title` beneath the name since
Phase 4 — gated on `title === ""`, with `CertSigner`'s comment explaining no field existed. The
whole change is therefore collector-side: `CertSignerRow` gains `title: string`, `printCert`'s
signer select adds it, and `readCertPdfData` passes `signer.title` where it hardcoded `""` (comment
updated to name ruling 14). The existing cert tests compile unchanged because they pass the full
User row (`findUniqueOrThrow`), which has carried `title` since Task 1's migration.

## Deviations

1. **No JSON-round-trip purity test for the quote builder** — deliberate and spec-anchored (§6:
   the footer callback is sanctioned because this render is code, not a Phase 7 template). The
   builder is still pure in the sense that matters: data in, definition out, no I/O, no clock.
2. **`User.title` is editable on the users table, not the Add-user form** — the brief pins the
   update path ("through `users.ts`'s audited update"); `createUser` is untouched and a new user's
   title defaults `""` (prints nothing) until keyed. Matches the page's existing per-row-control
   pattern (role select, active checkbox).
3. **The needs-price case on quote paper**: a row with no unit price and no minimum still prints
   whatever it does carry (the engine's rule 3 — a setup-only row's amount is its setup). Nothing
   in spec §6 covers it; the engine's answer is printed rather than a second opinion invented.
4. **`money4` for unit/break prices** (deviation 7 above) — a formatting divergence from the
   invoice builder's 2-decimal `money`, on the stated grounds; flagged for the demo alongside the
   layout deviations.

## Gate results

| Gate | Result |
|---|---|
| `npm test` | **130 files passed, 2122 tests passed, 0 failed** (+28 over Task 9: quote-pdf 25, users +1, cert-pdf +2) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | ✓ Compiled successfully; `/api/quotes/[id]/print` and `/api/quotes/[id]/documents` both in the route manifest |
| `npm run test:e2e` | **All 18 flows passed** (exit 0) — **verified by the controller, not the implementer** (corrected 2026-08-11: the implementer's watched runs were killed three times — twice by turn-end SIGTERM, once by a machine restart that also stopped Docker — and this row had been pre-written as a green claim no one had yet seen; the controller restored the db container and ran the suite to completion itself). No flow drives `/quotes/[id]` or `/admin/users` directly yet — the dedicated quote flow is Task 11's deliverable — so this run is the standing whole-suite regression guard on any UI-touching change. Dev-DB fixtures: the harness cleaned its own; the controller found and purged surviving Task 9 SMOKE fixtures (customer `T9SMK`, 2 quotes, 1 order + parts subtree) that Task 9's cleanup claim had missed — all fixture tables verified at zero rows after the purge |

## For the reviewer to scrutinize

- **The OPERATION-order mapping in `indicativeAmounts`** (`quotes.ts`): amounts map back to price
  rows by array index over `result.lines.filter(kind === "OPERATION")`. That 1:1-in-order contract
  is the engine's own (one OPERATION per input row, pushed in input order; the zero-rows case
  returns early so the needs-price synthetic line can't misalign) — but it is a structural
  assumption on `priceOrder`, not a type-enforced one.
- **The LB-no-weight omission is per-ROW, not per-line**: a line with qty but no each-weight still
  prints amounts for its EACH/PER_100/PER_1000/LOT rows (their basis — qty — is known) while its
  LB rows omit. Tested both ways; worth confirming that reading of spec §6's "(and weight, for LB
  rows)".
- **`totalLbs` and `shippedWeight` are the raw float product** `quotedQty × eachWeight` — display
  rounds to 2dp (`weight()`), and the engine rounds the weight to hundredths internally
  (`Math.round(weight * 100)`); no Decimal multiplication was added. A 4-decimal each-weight ×
  large qty stays exact well past any realistic magnitude, but it is float arithmetic.
- **The footer callback in a stored-definition world**: nothing stores quote definitions today
  (only rendered bytes), but if Phase 7's template designer ever ingests this builder, the callback
  is the one member that won't survive serialization — the file comment says so.
- **`TitleCell`'s PATCH-on-blur** (admin users page): no §5.16 gate on the input itself — the
  page's other row controls (role select, active checkbox) carry none either (the page is reached
  through `manage_users`-gated APIs and every PATCH 403s without it); kept consistent with the
  sibling controls rather than gating one cell of five.
