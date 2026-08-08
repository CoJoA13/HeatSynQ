# Task 19 report — `pdf/invoice.ts`: the invoice/credit PDF, print and archive

**Status: DONE**

## What I implemented

The last feature task of Phase 5A: render an invoice (and a credit) to a PDF, print it through a
route, and archive the bytes as a `StoredDocument` — following the traveler/cert/ticket/BOL print
machinery exactly, not a fourth pattern.

### Files changed

- **`src/server/pdf/invoice.ts`** (new) — the PURE builder (`InvoicePdfData` in, plain-JSON pdfmake
  definition out), on `pdf/cert.ts`'s structure: header comment naming `docs/samples/Invoice
  Sample.pdf` as the contract and listing every deviation; plain input types; pure locale-pinned
  formatters (`money`/`weight`/`qty`/`longDate`); one `function xBlock(d): Content` per visual block
  (title + company, identity column, Remit To box, Billto/Shipto, the column header strip, the order
  strip, the PARTS rows, the PRICE block, the totals); the exported `buildInvoiceDefinition`.
- **`src/server/invoices.ts`** — added `invoicePrintSettings()` (company + remit-to, read OUTSIDE the
  transaction), `readInvoicePdfData()` (pure read off the FROZEN invoice detail), `claimInvoiceForPrint()`
  (the print claim), `printInvoiceInTx()`, and `printInvoice()` (public, optional `tx`).
- **`src/app/api/invoices/[id]/print/route.ts`** (new) — `POST`, gated `invoicing.view`, streams the
  PDF with the resolved filename and `x-document-id`.
- **`src/server/documents.ts`** — `listDocumentsForOrder`'s `OR` gained `{ invoice: { orderId } }` so
  an invoice/credit surfaces on its order's hub. (Task 2 had already done the schema-shaped half —
  see "documents.ts already vs owed" below.)
- **`src/app/orders/[id]/DocumentsSection.tsx`** — `KIND_LABELS` completed over all six kinds
  (TRAVELER/SHIPPER/BOL/CERT/INVOICE/CREDIT), closing the cosmetic gap HANDOFF §6 recorded.
- **`tests/invoice-pdf.test.ts`** (new) — the builder purity/content tests, the print/archive/reprint
  tests, the discard-refusal test, the credit test, the **concurrency test**, and the route
  401/403/200 tests.
- **`tests/documents.test.ts`** — added the INVOICE/CREDIT `documentFilename` cases
  (`invoice-72026.pdf`, `credit-1000.pdf`, plus the raw-id fallbacks).
- **`e2e/flows/multi-order-shipment.mjs`** — updated to expect the now-friendly hub labels ("Bill of
  lading"/"Shipping ticket"/"Certification") instead of the raw enum names it used to encode (see
  "E2E" below). This is a direct, required consequence of completing `KIND_LABELS`.

## documents.ts — already there vs what I owed

**Already in place (Task 2), verified:** `AREA_FOR_KIND` has `INVOICE`/`CREDIT: "invoicing"`;
`DocumentOwner` has both arms; `ownerColumns` maps both to `invoiceId` alone; `DocumentMeta.invoiceId`
exists; `documentFilename`'s INVOICE/CREDIT cases (`invoice-<order>.pdf` / `credit-<credit#>.pdf`) and
`resolveDocumentFilename`'s INVOICE/CREDIT branch exist. No schema change was needed — INVOICE/CREDIT
were already in the `DocumentKind` enum and the re-stated CHECK (migration `20260806221500`).

**What I owed and did:** the `{ invoice: { orderId } }` branch in `listDocumentsForOrder`; the
exhaustive `KIND_LABELS`; and the previously-untested INVOICE/CREDIT `documentFilename` cases.

## TDD evidence

Wrote `tests/invoice-pdf.test.ts` and the `documents.test.ts` additions against not-yet-existing
exports, implemented, then GREEN:

```
✓ tests/documents.test.ts (31 tests)
✓ tests/invoice-pdf.test.ts (15 tests)
Test Files  2 passed (2)   Tests  46 passed (46)
```

### The concurrency RED (claim removed)

`printInvoice` MUST claim the invoice row before archiving. To prove the test discriminates, I
temporarily replaced `claimInvoiceForPrint(tx, id)` in `printInvoiceInTx` with unlocked
`findFirst` reads (no `claimOrder`, no `FOR UPDATE`) and ran the concurrency test:

```
FAIL  tests/invoice-pdf.test.ts > printInvoice > claims the invoice row before archiving …
  await expect(printCall).rejects.toThrow(/voided/i);   // printCall RESOLVED with a Buffer instead
  Test Files  1 failed (1)   Tests  1 failed | 14 skipped (15)
```

With the claim removed, `printInvoice` reads the invoice through an unlocked snapshot (still live
while the discard-holder's soft-delete is uncommitted), renders, and its `storeDocument` insert
lands AFTER the holder commits the delete — a discarded invoice with an archived PDF, and
`printInvoice` **resolves instead of rejecting**. Restored the claim → GREEN:

```
✓ printInvoice > claims the invoice row before archiving: a discard-holder makes print refuse … 
```

The competitor (print) runs at Read Committed via a manually-opened `tx`, so ONLY the row lock — not
SSI — orders the two (the `createInvoice`/`finalizeInvoice` concurrency-test precedent).

## How printInvoice claims the invoice row before archiving

`printInvoiceInTx` opens a Serializable transaction and calls `claimInvoiceForPrint(tx, id)`, which
claims the **Order row** (`claimOrder`) then the **Invoice row** (`SELECT … FOR UPDATE`), one fixed
order — the same claim `discardInvoice`/every invoice mutator takes. Only then does it
`assertPrintable(order)` / `assertPrintable(invoice)`, read the payload on `tx`, render, and
`storeDocument(tx, …)`. Because print takes the SAME claim discard does, discard's "is it printed?"
read (which lives on the `StoredDocument` rows, not the Invoice row) and print's archive insert
serialize on the shared row lock; Serializable alone is not the guarantee.

`claimInvoiceForPrint` deliberately does NOT 404 a discarded invoice (unlike `claimInvoiceRow`): it
returns the row with `deletedAt` intact so `assertPrintable` refuses a NEW print with the shared
`VOIDED_PRINT` 400, while stored prints stay reprintable forever.

## Byte-determinism (stored vs fresh)

- **STORED bytes on reprint** are compared exactly: `Buffer.compare(getDocument(id).fileData,
  printed.pdf) === 0` — the whole point of archiving.
- **Two FRESH renders** are NEVER `Buffer.compare`d (renderPdf's deflate is not byte-stable across
  calls). The fresh-render test pins the rendered file STRUCTURALLY (`%PDF-` header + `pageCount`
  off the `/Type /Pages /Count` marker) and pins CONTENT on the DEFINITION via `allText` (pdfkit
  writes TTF-subset glyph ids, so rendered bytes carry no character text to grep).

## Discarded-refuses-new-but-reprints-stored

`printInvoice` on a discarded invoice or a voided order throws `VOIDED_PRINT` (via
`assertPrintable`); the stored document from an earlier print still downloads
(`getDocument(...).resolves`). Covered by two tests (discarded invoice; voided order).

## The two recorded deviations (spec §10)

1. **No "Page N of M"** — a pure-JSON definition cannot carry a page-count function (pdfmake exposes
   it only to callbacks), and a hard-coded "1 of 1" would lie on a wrapped invoice. The identity
   column prints Invoice No. / Invoice Date / Terms and omits the sample's "Page No." line — the
   shipping ticket's and cert's identical deviation. Pinned by `expect(text).not.toContain("Page No.")`.
2. **`Process:` prints the lead part's priced operation names comma-joined** (`processNames`,
   snapshotted at create) — byte-identical to the sample whenever a part has one priced operation.

## Decision flagged for owner/reviewer confirmation

**A credit titles itself "Credit" (not "Invoice").** Spec §10 says "Credits print the same layout
with the credit number and negative amounts" and does not enumerate the title as a difference. I
made the title DATA (`InvoicePdfData.title`, set by `readInvoicePdfData` off the invoice's own kind)
and titled credits "Credit", because a credit memo is a distinct financial document and titling it
"Invoice" would be misleading paper to a customer. The layout/structure is identical; only the title
text and the signs differ. If the owner wants the literal word "Invoice" on a credit, it is a
one-line change in `readInvoicePdfData`.

## Layout fidelity

Rendered the sample data to a real PDF and eyeballed it against `docs/samples/Invoice Sample.pdf`:
title + company, identity block (no Page No.), Remit To box, Billto/Shipto, the column strip, the
order strip, PARTS (qty / part no. + name / each weight / total wt), the PRICE block ("Austemper …
$937.44", "Price per Each: $6.51 Or", "Minimum Charge: $600.00"), Sub Total / EnergySur / Total
Amount Due, and the footer contact strip all match.

## billTo/shipTo design note

`InvoicePdfData.billTo`/`shipTo` are `string[]` (the invoice's FROZEN snapshot strings split on
newline), not structured `{name,street,city,state,zip}` objects as the brief's illustrative
sampleData showed. An invoice is frozen paper (invoices.ts's `toLineDetail` rule) — billTo/shipTo
MUST be the stored snapshot, never a live re-read of the customer's current address, and the
snapshot is a rendered multi-line string. `remitTo` (the plant's own remit address, not frozen
per-invoice) comes from company settings as `{ name, lines }`.

## E2E

`multi-order-shipment` failed on the first run: it waited for order-hub document links named exactly
`"BOL"`/`"SHIPPER"`/`"CERT"`, with its own comment stating "the hub's generic list renders
non-traveler kinds by their **raw kind name**" — i.e. it encoded the very cosmetic gap this task's
`KIND_LABELS` completion closes. I updated the flow's comment and its five assertions to the friendly
labels. Re-ran the full suite: **all 15 flows pass.** (No existing flow exercises invoice PRINT yet —
Task 20 adds the 16th flow — but I touched a flow-exercised UI file, `DocumentsSection.tsx`, so the
owner rule required the E2E run, which is what caught the label regression.)

## Gates (all green)

| Gate | Result |
| --- | --- |
| `npm test` | 1683 passed (109 files) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |
| `npm run build` | compiled; `/api/invoices/[id]/print` registered |
| `npm run test:e2e` | 15/15 flows pass |

## Self-review

- Would each test fail if the behavior regressed? Yes — the concurrency test goes RED with the claim
  removed (captured above); the reprint test compares STORED bytes exactly; the fresh-render test
  pins content only; the discarded/voided tests refuse a new print while reprinting a stored one; the
  route tests pin 401/403/200 + `content-disposition`.
- Every mutation (the archive insert) is through the sanctioned `storeDocument` path, on `tx`, under
  the claim; the audit payload carries no bytes (asserted).
- No schema change (INVOICE/CREDIT already in the enum + CHECK).
- No new print pattern — reused `renderPdf`, `storeDocument`, `assertPrintable`, `claimOrder`,
  `resolveDocumentFilename`.

## Concerns

- The credit title decision (above) is the one place I chose beyond the literal spec text; flagged
  for confirmation.
