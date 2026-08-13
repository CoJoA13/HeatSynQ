# Task 12 report — Invoice/credit conversion (+ processName snapshot, #98)

**Implementer:** subagent, 2026-08-13.
**Branch:** `phase-7-template-designer`
**Commits:**
- `9f51e99` — create-time `processName` snapshot source (spec §5.7, ruling 4) + #98's
  `sourceQuoteNumber`-requires-QUOTE refine (both service-level frozen-paper changes; new
  `tests/invoice-templates.test.ts` with RED evidence).
- `9cbf8a7` — `buildInvoiceDefinition` becomes a config-consumer over FROZEN data (builder + the
  config-driven / negative-knob / date / §5.6 / logo / pageFooter / overflow describes).
- `827ab60` — `printInvoice` resolves the INVOICE template, stamps `resolved.versionId`, embeds the
  logo; `claimInvoiceForPrint` and the print-vs-discard serialization untouched.

## The frozen-paper preservation argument (the defining constraint)

The invoice is the **OPPOSITE snapshot rule** from the cert/shipper (CLAUDE.md, ruling 24's
refinement): `InvoicePdfData`'s identity and pricing fields are read UNCONDITIONALLY from the
invoice row's frozen snapshot columns — never re-joined to their live source. The conversion holds
that line three ways:

1. **The builder maps config over the frozen data it is handed.** `buildInvoiceDefinition(input,
   config, logoDataUri?)` receives `InvoicePdfData` exactly as before — built by
   `readInvoicePdfData` from `Invoice`/`InvoiceLine`'s frozen columns (`billTo`/`shipTo`/
   `documentNumber`/amounts/`processNames`). The config controls placement/labels/widths/fonts/
   formats/logo; it introduces **no** live re-join and **no** live-join-first-with-fallback branch
   (there is nothing to fall back to — a draft edit replaces the whole line array, §5.5). The
   contract (Task 2) already maps only onto frozen columns; the builder was not widened.
2. **A relabel/reformat changes layout, never numbers.** The config-driven test "a label override
   prints in place of the contract default" asserts the FROZEN `7 - 72026` and `$974.94` are
   unchanged while the labels move.
3. **A raised invoice's paper is frozen bytes.** The print-path test "a template edit after an
   invoice is raised changes NOTHING on reprint" prints under template A (`ORIGINAL-MARKER:`),
   publishes+assigns template B (`CHANGED-MARKER:`), and proves the STORED bytes are reissued
   byte-for-byte (`Buffer.compare === 0`) carrying only the original marker — a reprint reissues
   `getDocument`'s stored bytes, never re-renders under the new template.

The golden gate is met the strong way: **`tests/invoice-pdf.test.ts` has ZERO edits and stays
17/17 green** through the converted path (the default config reproduces today's paper — every
label, width, font size, both money/date formats and the negative style reproduce the builder's
literals exactly), alongside the 5A `invoices`/`invoice-routes`/`invoice-guards` suites, all
unedited.

## The processName create-time wiring (spec §5.7, ruling 4)

`Part.processName` is presentation vocabulary. Its INVOICE half folds into the EXISTING
`Invoice.processNames` snapshot **at create time** (`createInvoiceInTx`, invoices.ts): the lead
part's `processName` when non-blank (`.trim() !== ""`), else today's priced-operation comma-join
(the quote-aware `leadPrices` join is preserved as the fallback). `ORDER_LINE_SELECT` gained
`processName: true` and `LeadPart` the field.

This is the **only** behavioral change to invoice data, and it is at CREATE time only:
- Prints read `detail.processNames` (the frozen column) UNCONDITIONALLY — no render-time read of
  the live part.
- `recalculateInvoice` explicitly does NOT touch `processNames` (its own comment: "The descriptive
  header snapshots … process names … are NOT touched"), and finalized invoices don't recalc — so
  the snapshot is frozen from create on.
- Credits copy the source invoice's snapshot (unchanged).

The **load-bearing frozen-paper proof** (`invoice-templates.test.ts`): create+finalize an invoice
whose part carries `processName = "MARQUENCHZONE"` → the snapshot and the printed paper carry it;
edit the live part to `"EDITEDAFTERWARD"` AFTER the invoice is raised → the frozen column is
unchanged, a fresh render still prints the frozen value (never the edit), and the first print's
STORED bytes decode to the frozen value. Pre-existing invoices are untouched (their snapshot
already holds the join — the blank-fallback test pins this).

## #98 (LINE_INPUT gains the refine)

`LINE_INPUT` (the manual invoice-lines save, `replaceInvoiceLines`) gains a `.refine` allowing
`sourceQuoteNumber` only when `priceSource === "QUOTE"` — a `ZodError` (→ clean 400) otherwise.
This is shape-tightening on a permission-gated, audited surface, **not** authenticity verification
against live quotes (a deliberate frozen-paper non-goal, §7.5). The echo-back for genuine QUOTE
lines is untouched. Tested both directions: a MANUAL and a null-source line carrying a
`sourceQuoteNumber` are refused; a QUOTE line's `sourceQuoteNumber` round-trips; an ordinary
MANUAL charge (no number) passes.

## The overflow finding (investigate-first) — the band IS warranted

**A real invoice genuinely overflows one page.** Probed empirically against the pre-conversion
builder BEFORE writing the continuation code:

| driver | live bound | pages |
|---|---|---|
| parts (order lines) | `z.array(LINE).min(1)` — **NO max** (orders.ts) | 1→1, **15→2**, 25→2, 40→3 |
| priced operations | grow with the parts / quote breaks | **20→2**, 40→3 |

So the `continuationHeaderSpec` is NOT dead code. The band repeats the invoice's identity —
`Invoice No.: <documentNumber>` under the `invoice_no` field's label plus "(continued)",
`overflowTopMargin: 40` (a text-only band; the two-pass render keeps a one-page invoice's margins
byte-identical). The `invoice_no` label override carries; the visibility flag is deliberately
ignored (identity on paper is locked — the BOL/cert band treatment; both halves tested). The
overflow itself is pinned through rendered bytes: a 40-part invoice is ≥2 pages, page 1 clean, the
last page carrying "(continued)".

## Config-mapping decisions (the ones a reviewer should weigh)

1. **The four data columns are a GRID owned by `column_header`.** Every body block (parts rows,
   price operation rows, order-strip indent, totals amount column) aligns to the same widths,
   defined once by `column_header`'s visible column fields (in config order). A width override or a
   hidden column flows through the whole page — and a hidden column frees width budget exactly as
   the validator's `assertWidthBudgets` models it (visible columns only). The `parts`-section
   fields (`part_qty` etc.) gate the per-row VALUE within that grid (blank cell when hidden); the
   `column_header` fields gate the COLUMN's existence. Dual control, each independently testable.
2. **The identity/order-strip label glue is builder-side.** The contract's `defaultLabel` carries
   no trailing spaces ("Invoice No.:"); the sample's alignment spacing ("Invoice No.:  ",
   "Our Order #: ") is glue the builder appends, so a label override replaces the label and the
   glue stays. Byte-identical at the default.
3. **`title`/`company_name` are value-only (DATA), not label-driven** — the printed title is
   `d.title` (the row's kind), so a credit's paper differs only in its number and signs; the
   header's fields carry no printed label. The BOL's `ship_from` / cert's signature-label decision.
4. **The `negativeStyle` knob is the invoice contract's first real declarer** (ruling 3).
   `makeMoney` renders the magnitude with `priceDecimals`/`thousandsSeparator`, then applies the
   style: `SIGN_AFTER_SYMBOL` (default) is today's "$-937.44", `LEADING_MINUS` "-$937.44",
   `PARENTHESES` "($937.44)". The default reproduces today's `money()` byte-for-byte; all three
   styles are tested on a credit fixture AND through the real print path.
5. **The footer is a page-margin strip, not a content-flow section** (the cert precedent) — pulled
   out of the content loop into the footer slot regardless of its position in the section order;
   only its visibility and its fields' labels apply. Bottom margin 44 unconditional (the invoice
   has always carried a per-page strip); the `pageFooter` knob changes only where the strip and the
   count go (OFF → plain `footer`, ON → the pageNofM `above` slot), keeping the default
   byte-identical.
6. **The date knob has no style trap** (the ticket's rule, generalized): `longDate` was the SOLE
   date renderer with ONE call site (the Invoice Date), so the single `dateFormat` knob maps to it
   directly — all five styles tested, the default "MMMM D, YYYY" ("July 29, 2026") pinned.
7. **`priceDecimals`/`thousandsSeparator` map to the one `money()`/`weight()`/`qty()` surface** —
   the invoice has a single money formatter (no `money4` split like the quote), so the knob applies
   uniformly; the weight/qty decimals are data precision (not the price knob), grouping rides
   `thousandsSeparator`.

## RED evidence (each cycle ran red before its implementation)

**#98 + processName** (against the pre-change service — `9f51e99`'s tests):
```
× refuses a MANUAL line that carries a sourceQuoteNumber        (no refine yet → accepted)
× refuses a null-priceSource line that carries a sourceQuoteNumber
× snapshots part.processName when it is non-blank               expected "MARQUENCHZONE", got "Austemper"
× a processName edit after finalize changes NOTHING …           MARQUENCHZONE not on paper (not snapshotted)
× a credit copies the source invoice's frozen processNames …    got "Austemper"
 Tests  5 failed | 3 passed (8)   (the 3 passing: 2 QUOTE/MANUAL "allows" + the blank fallback)
```

**Builder conversion** (config parameter ignored — the pre-conversion one-arg builder, stashed):
```
× a label override prints in place of the contract default
× a width override lands in the column-header strip's widths array
× a hidden section / hidden column field / hidden non-column field …
× stack order / field order follow the config
× family, base size and role sizes map into the definition
× thousandsSeparator: false ungroups quantities, weights and money
× renders the invoice date as M/D/YYYY  [+ MM/DD/YYYY, YYYY-MM-DD, MMM - DD - YYYY]
× renders LEADING_MINUS / PARENTHESES on a credit's negative amounts
× nothing on this contract is locked: … the builder honors it
× a header-center / header-left / header-right logo …
× the knob ON moves the company strip onto the pageNofM footer's `above` slot [+ hidden-footer, band, override, overflow]
 Tests  24 failed | 17 passed (41)
```
(The 17 passes are the golden-holding tests — default date, default SIGN_AFTER_SYMBOL, the two
omission-belt shapes, pageFooter-OFF default footer, the no-logo fallback, purity, and the
#98/processName 8 — they pass against the unconverted builder BY DESIGN.)

**Print path** (template machinery not consulted — all 7 red after the builder commit):
```
× no assignment: … stamps ITS version id            → expected null to be 'standard-invoice-v1'
× a label override prints through the real path      → drawnText missing 'TOTAL-MARKER:'
× BOTH an invoice and its credit resolve INVOICE …   → missing 'SHARED-MARKER:'
× the negativeStyle knob formats a credit …          → missing '($937.44)'
× the pageFooter knob prints per-page numbers        → missing 'Page 1 of 1'
× a placed logo prints through the real path         → expected [ 0 ] to deeply equal [ 1 ]
× a template edit … changes NOTHING on reprint       → missing 'ORIGINAL-MARKER:'
 Tests  7 failed | 41 skipped (48)
```
The resolution tests run the REAL services end to end (`createTemplate` → `editDraft` →
(`uploadLogo`) → `publishDraft` → `assignTemplate` → `printInvoice`), decoding assertions from the
rendered/stored bytes (`drawnText`/`drawnPages`/`paintedImageCounts`) and reading the stamp off the
stored row.

## Gate results (watched to completion)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | PENDING | — |
| `npx tsc --noEmit` | clean | 1.8s |
| `npx eslint src tests` | clean | — |
| `npm run build` | PENDING (deferred until E2E finishes — shared `.next`) | — |
| `npm run test:e2e` | PENDING (detached, sentinel `e2e-task12.done`) | — |

Dev-DB fixture hygiene: pre-run counts 0 across all E2E fixture values
(`Customer.code`/`User.username`/`Role.name`/`ProcessStepCode.code`/`DocumentTemplate.name`).

## Deviations

1. **`buildInvoiceDefinition` now returns `RenderableDefinition`** (was `TDocumentDefinitions`) —
   the structural superset carrying the two declarative spec keys (the cert/BOL precedent); every
   caller and the golden suite type-check unchanged.
2. Nothing else — `settings.ts` untouched; the invoice carries no text blocks, so no data-seam /
   config-literal text binding was needed (its texts are all data or labels).

## Notes for Task 13 (statement — the fully-live-rebuild document + #87 filename sanitize)

- **The statement is the OPPOSITE of the invoice again** — it is a fully-LIVE rebuild at print
  time (aging computed live), not frozen paper. Its config-consumer conversion has no frozen-column
  constraint; the live-read discipline is its own.
- **#87 is the statement's own scope** (filename sanitize for the stored-document download).
- The company-strip `above` infra and the config-consumer lens (`sectionView` over
  `completeSections`, the §5.6 belt) copy verbatim; the invoice adds the grid pattern
  (`column_header` owns the widths, body blocks align to them) if the statement has a similar
  header-strip-plus-body shape.
- Per-task sentinel discipline (`e2e-task13.done`), detached from the start, dev-DB fixtures
  cleared, `npm run build` deferred until E2E finishes (shared `.next`).
