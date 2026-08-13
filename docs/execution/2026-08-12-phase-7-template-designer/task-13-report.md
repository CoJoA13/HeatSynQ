# Task 13 report — Statement conversion (+ #87 filename sanitize)

**Implementer:** subagent, 2026-08-13.
**Branch:** `phase-7-template-designer`
**Commits:**
- `6c4d7c7` — #87: one safe Content-Disposition leaf (`src/server/content-disposition.ts`), adopted
  in the statement print route AND the generic `/api/documents/[docId]` download; `attachments.ts`
  delegates so the RFC 5987 encoding lives in one place. New `tests/content-disposition.test.ts`.
- `a9102ef` — `buildStatementDefinition` becomes a config-consumer over LIVE data (builder + the
  config-driven / date / negativeStyle / §5.6 / logo / pageFooter / overflow describes).
- `20b3ef4` — `printStatement` resolves the STATEMENT template, stamps `resolved.versionId`, embeds
  the logo; the preview GET stays side-effect-free; the LIVE-REBUILD proof.

## The live-rebuild preservation argument (the defining constraint)

The statement is the **THIRD snapshot posture** (CLAUDE.md): invoice = frozen-unconditional,
shipper/cert = live-join-with-fallback, **statement = a fully-live rebuild every print, no snapshot
at all**. `statements.ts`'s `buildStatementInTx` reads the live open items, the live default BILL_TO
address, and the point-in-time aging on every call; printing archives its OUTPUT, so a reprint is
byte-exact only because the bytes were stored, NOT because the input was frozen. The conversion
holds that line:

1. **The builder is pure `StatementData` → definition.** `buildStatementDefinition(input, config,
   logoDataUri?)` maps config (placement/labels/widths/fonts/formats/logo) over whatever live data it
   is handed. It introduces no frozen-column constraint and no snapshot fallback — the live-read
   discipline stays entirely in `statements.ts`, untouched.
2. **The config styles the paper; the numbers are the live rebuild.** The config-driven test "a label
   override … the live-rebuilt VALUES are untouched" asserts the numbers stand while labels move.
3. **The load-bearing LIVE-REBUILD proof** (the mirror image of the invoice's frozen-paper proof):
   print a statement carrying a live bill-to `ORIGINALBILLTO INC`; change the LIVE default bill-to to
   `CHANGEDBILLTO LLC` AFTER the print; a SECOND print shows the change (`CHANGEDBILLTO LLC`, not the
   original) — the statement is rebuilt, not frozen — while the FIRST print's STORED bytes are
   reissued byte-for-byte carrying the original (`Buffer.compare === 0`).

The golden gate is met the strong way: **`tests/statement-pdf.test.ts` has ZERO edits and stays 5/5
green** (the default config reproduces today's paper — every label, width, font size, both
money/date formats and the negative style reproduce the builder's literals exactly), alongside the
5B `statements`/`receivables-routes` suites, all unedited. The `receivables-routes` statement-header
assertion at :425 stayed byte-identical because the #87 leaf emits no `filename*=` for a plain-ASCII
customer code (see below).

## #87 — the shared safe-Content-Disposition helper

`src/server/content-disposition.ts` is a dependency-free leaf holding the RFC 5987 / quoted-string /
control-char primitives and `contentDispositionValue(disposition, filename, { alwaysExtended? })`. It
was extracted from `attachments.ts` (the original home of this encoding), which now delegates to it —
so the encoding lives in ONE place. Adopted in the two filename-emitting document routes the brief
names (the statement print route and the generic `/api/documents/[docId]` download).

**The conditional `filename*=` is the load-bearing design choice.** The document-download golden
tests pin the EXACT header `inline; filename="..."` with NO `filename*=` for ASCII names
(`documents.test.ts` ×5, `cert-pdf`, `invoice-pdf` ×2, `quote-pdf`, `receivables-routes` — the
Task 10/11/12 goldens this phase kept untouched). `attachments.test.ts`, conversely, pins
`filename*=` present **unconditionally**. One helper satisfies both: `alwaysExtended: false` (the
document surface — default) emits `filename*=` only when the name is non-ASCII, so every stored-paper
download header stays byte-for-byte today's while a non-ASCII name still downloads under its real
name; `alwaysExtended: true` (the attachments surface) keeps that surface's long-standing
unconditional behavior. Both preserved — attachments and documents goldens untouched and green.

**The archive-ordering finding (the brief asks which).** On the statement print path the archive
commits BEFORE the filename is resolved and the header built. Before the fix, a customer `code`
carrying a newline crashed the `Headers` constructor at that point, so the operator saw a failed
print behind an orphaned committed archive (issue #87 exactly, RED-reproduced —
`TypeError: Headers.append: "inline; filename="statement-ACME\n"OH.pdf"" is an invalid header
value`). **Sanitizing the filename makes the header construction non-crashing, which fully resolves
the orphan without reversing the ordering:** the archive that already committed is now exactly what
the operator wanted — the print returns 200 with the archived document (`x-document-id` set) and a
clean sanitized filename, and the reprint route serves the same bytes. So the ordering did not need
reversing; the sanitization closes it. Stated per the brief.

The hostile-code regression runs on BOTH routes (a code carrying `\r\n"` → a clean 200, a header free
of CR/LF, the quote backslash-escaped, the archive still returned) plus five direct
`contentDispositionValue` unit tests (ASCII byte-identity, CR/LF strip, quote/backslash escape,
non-ASCII `filename*=` round-trip, `alwaysExtended`).

## printStatement — resolution + stamp (claim-free by design)

`printStatementInTx` resolves `resolveTemplateForPrint(tx, "STATEMENT", customerId)` on its own
**claim-free Serializable** transaction — the statement owns no single row to CLAIM (a composed
report over many invoices), so resolution is correct by §5.1 immutability, not by locking (the
printInvoice/printCert precedent). It renders `buildStatementDefinition` against the resolved config +
logo (data-URI by the stored mime type, rendered only when the config also PLACES it) and stamps
`resolved.versionId` onto the archived row. `runStatements` inherits it. **The preview GET
(`buildStatement`) writes NO `StoredDocument`** — asserted side-effect-free, unchanged.

Tested through the real services end to end (`createTemplate → editDraft → (uploadLogo) →
publishDraft → assignTemplate → printStatement`): no assignment resolves the seeded Standard and
stamps its version; a label override / negativeStyle / pageFooter / placed logo each print through
the assigned template and stamp its version.

## The overflow finding (investigate-first) — the band IS warranted, with one boundary artifact

**A real statement genuinely overflows one page.** Open items are unbounded (a customer can carry
any number of open finalized invoices/credits/on-account payments), and ~34 single-line rows fill a
LETTER page (probed empirically against the builder BEFORE writing the continuation code: 30→1 page,
34→2 pages). So the `continuationHeaderSpec` is NOT dead code. The band repeats the customer identity
(`Customer: <code> — <name>` under the `customer` field's label) plus "(continued)",
`overflowTopMargin: 40`; the label override carries, the visibility flag is deliberately ignored
(identity on paper is locked — the invoice/BOL/cert band treatment). The aging strip and Total Due
are separate content blocks that flow AFTER the open-item table (which repeats its own header row on
continuation pages), so they land on the last page — pinned through rendered bytes (a 60-item
statement is ≥2 pages, page 1 clean, the last page carrying "(continued)" + "Unapplied" + "Total
Due").

**Finding worth flagging (a shared-mechanism boundary artifact, not statement-specific):** at
isolated open-item counts (n=40 and n=61 in the [34..140] sweep — ~2% of counts), the two-pass
overflow render leaves a **spurious blank trailing page**. It is a property of the shared `render.ts`
two-pass mechanism (Task 6/8), which renders the page-count probe at the original top margin (24) and
the final at the raised margin (40): at a count where the last table rows land exactly on the page
boundary, the margin difference flips a break and emits an empty continuation page. It is **absent
without the band** (single-pass) and **absent at neighboring counts** (37/38/39/41/42 all clean —
RED/GREEN isolation via a with-band vs no-band probe). Every converted overflow-capable document
(traveler/invoice/cert/BOL) rides the same mechanism and would have its own boundary counts; the
invoice's own overflow test at 40 *parts* passes because its rows are taller. This is cosmetic (a
blank trailing page at rare specific row counts, no data loss), lives in shared render infra outside
Task 13's scope, and a fix there risks the four other conversions' goldens — so it is reported for
triage rather than fixed on-branch (the phase's cosmetic-defers-to-issue rule). The Task 13 overflow
test uses n=60 (well clear of the boundary).

## Config-mapping decisions (the ones a reviewer should weigh)

1. **The open-item columns are builder-owned widths, not a column knob** (the contract's own choice —
   these fields carry no `column` spec). `OPEN_ITEM_WIDTH`/`OPEN_ITEM_ALIGN` are builder constants;
   templates get label/visibility/order over them, and hiding a field drops its whole column
   (header + cells), the widths shrinking. The **aging** fields, by contrast, DO carry a `column`
   knob (defaultWidth "*"), so those columns are re-widthable within the aging table's budget — dual
   control, each independently tested.
2. **`title` is a LABEL here, not DATA** (unlike the invoice, whose title is the row's kind). Nothing
   kind-varies a statement's title, so the contract makes it overridable text (`defaultLabel
   "Statement"`), printed at `headingSize`; `company_name` is value-only (prints `d.company.name`).
3. **The identity left-column fields carry their OWN sample margins** (unlike the invoice's
   homogeneous position-based rule) — the statement's identity lines are heterogeneous: a plain
   label-value line (customer), a spaced one (statement date, `[0,2,0,0]`), and an underlined address
   block (bill-to, `[0,6,0,0]`). The default is byte-identical; a reorder keeps each field's margin.
4. **`negativeStyle` formats the statement's negative money** (a credit or on-account PAYMENT row's
   Open amount, a net-negative aging bucket): `SIGN_AFTER_SYMBOL` default "$-200.00", `LEADING_MINUS`,
   `PARENTHESES` — all three tested on a payment fixture AND through the real print path (a finalized
   credit → "($200.00)"). The default `money()` byte-for-byte.
5. **The single date knob maps to BOTH date slots** (the Statement Date and each open item's
   Date/Due Date) with no two-styles trap: `longDate` was the sole date renderer, so one knob, all
   five styles tested, default "MMMM D, YYYY".
6. **`pageFooter` defaults OFF** and the statement carries no static per-page strip (unlike the
   invoice/cert), so ON is a bare "Page N of M" (no `above` slot) and OFF prints no footer at all —
   the default byte-identical (bottom margin 40 unconditional, today's).
7. **`smallSize` gets its first slot** — the continuation band's "(continued)" line (the invoice
   precedent). Default 9 = base, so byte-identical at default; it only ever shows on overflow pages.
8. **No text-block seam** — the statement contract carries no text blocks (verified: `textBlocks:
   []`), so there is no data-seam / config-literal text binding here (unlike the cert/BOL).

## RED evidence (each cycle ran red before its implementation)

**#87** (against the unfixed routes — `tests/content-disposition.test.ts`, the two route regressions):
```
TypeError: Headers.append: "inline; filename="statement-ACME
"OH.pdf"" is an invalid header value.
 ❯ src/app/api/receivables/statements/route.ts:45  (the statement print route)
 ❯ src/app/api/documents/[docId]/route.ts:34       (the generic download route)
 Tests  2 failed (2)
```

**Builder conversion** (config parameter ignored — the pre-conversion one-arg builder from git HEAD):
```
× a label override … / an aging width override … / a hidden section … / a hidden open-item field …
× a hidden aging column … / stack order … / field order … / family, base size and heading size …
× thousandsSeparator: false ungroups money / date knob M/D, MM/DD, YYYY-MM-DD, MMM-DD (4 of 5)
× negativeStyle LEADING_MINUS / PARENTHESES / hide ANY section / pageFooter ON / continuation band
× logo header-center / -left / -right / overflow band
 Tests  23 failed | 9 passed | 7 skipped (39)
```
(The 9 passes are golden-holding — default date "MMMM D, YYYY", default SIGN_AFTER_SYMBOL, the two
omission-belt shapes, pageFooter-OFF default, no-logo fallback, purity, positive-money default — they
pass against the unconverted builder BY DESIGN, the invoice pattern.)

**Print path** (template machinery not consulted — 5 resolution describes red after the builder
commit; the 2 live-rebuild/preview describes PASS, correctly — that property is PRESERVED, not
introduced):
```
× no assignment: … stamps ITS version id    → expected null to be 'standard-statement-v1'
× a label override prints through …          → drawnText missing 'TOTAL-MARKER:'
× the negativeStyle knob formats a credit …  → missing '($200.00)'
× the pageFooter knob prints per-page …      → missing 'Page 1 of 1'
× a placed logo prints through …             → expected [ 0 ] to deeply equal [ 1 ]
✓ a live bill-to change … shows in the SECOND print   (the live-rebuild is already true — preserved)
✓ the preview build writes NO StoredDocument          (already side-effect-free — preserved)
 Tests  5 failed | 2 passed | 32 skipped (39)
```

## Gate results (watched to completion)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2624/2624, 143 files** (Task 12 baseline 2578/141 — **+46**: `tests/content-disposition.test.ts` (7) + `tests/statement-templates.test.ts` (39)) | 259.2s |
| `npx tsc --noEmit` | clean | 1.8s |
| `npx eslint src tests` | clean | 10.7s |
| `npm run build` | exit 0 (deferred until E2E finished — shared `.next`) | 16.1s |
| `npm run test:e2e` | **19/19 flows PASS** — detached from the start with the PER-TASK sentinel `e2e-task13.done`, result read from the run's own log (19 `PASS` lines, "All 19 flows passed", "cleanup ok", `EXIT:0`); the statement print/archive path is exercised by `receivables-apply-age-statement` | ~9 min |

Dev-DB fixture hygiene: pre-run counts 0 across all E2E fixture prefixes (`Customer`/`User`/`Role`/
`ProcessStepCode`/`DocumentTemplate` E2E-prefixed rows); post-run direct check against the DEV
database (`erp`) **0/0/0/0/0 again**, alongside the harness's own "cleanup ok".

## Deviations

1. **`buildStatementDefinition` now returns `RenderableDefinition`** (was `TDocumentDefinitions`) —
   the structural superset carrying the two declarative spec keys (the invoice/cert/BOL precedent);
   every caller and the golden suite type-check unchanged.
2. **#87 is a NEW helper, not a verbatim reuse of `attachments.contentDisposition`.** That helper
   emits `filename*=` unconditionally, which would break ~10 stored-document download golden
   assertions across five files. The leaf's conditional `filename*=` keeps every one byte-identical
   while sharing the encoding primitives; `attachments.ts` delegates with `alwaysExtended: true` and
   stays byte-identical too. Argued in the #87 section.
3. Nothing else — `settings.ts` untouched (the statement carries no text blocks); no schema change.

## Notes for Task 14 (quote — the LAST conversion)

- **The two-money-precisions trap is the headline** (carried from the Task 2 review): the quote
  prints `money()` 2dp (setup/minimum/indicative amounts) vs `money4()` 4dp (unit/break prices)
  against ONE `priceDecimals` knob — map the knob to unit/break prices ONLY, or a sub-cent setup
  charge changes at the golden-compat gate (the ticket two-date-styles analog).
- **The footer-callback retirement**: the quote's builder already prints "Page: N of M" via its own
  footer callback, and its contract alone sets `pageFooter: true` — the conversion maps that to
  render.ts's `pageNofM` with label `"Page:"` (the render.ts doc comment already anticipates this).
- **The settings-retirement completion**: Task 14 is where the remaining standing-text Settings
  (cert_statement etc. already retired; confirm none of the quote's texts still read a Setting) reach
  their final removal — the whole-branch note from the Task 11 review flags confirming no Setting is
  stranded between Task 3's seed migration and Task 14's key removal.
- **The #87 leaf and the config-consumer lens copy verbatim**; the quote already has its own money4
  split, so its overflow/band and negativeStyle handling follow the invoice/statement pattern.
