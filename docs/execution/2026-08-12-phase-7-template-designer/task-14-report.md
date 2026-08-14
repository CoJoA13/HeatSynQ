# Task 14 report — Quote conversion (the LAST conversion) + #97 + settings retirement completes

**Implementer:** subagent, 2026-08-13.
**Branch:** `phase-7-template-designer`
**Commits:**
- `a29b287` — `buildQuoteDefinition` becomes a config-consumer; the Phase 6 footer callback retires
  to `pageFooterSpec`; the two-money-precisions split; the intro/liability data-seam; `printQuote`
  resolution + version stamp; #97's `alignOperationAmounts` guard. New `tests/quote-templates.test.ts`.
- `b09c1b2` — the four standing-text Settings retired from `settings.ts` + `settings-ui.ts`; the
  vestigial cert/shipper readers fixed; migration `20260813120000_retire_standing_text_settings`;
  the affected tests updated.

**This is the eighth and final document conversion.** All eight document builders — traveler,
shipper/MOS-shipper, BOL, cert, invoice/credit, statement, and now quote — are config-consumers over
a validated `TemplateConfig`. The render/contract/service infrastructure (the §5.3 contract +
backfill, `completeSections`, `resolveTemplateForPrint`, `renderPdf`'s `pageFooterSpec`/
`continuationHeaderSpec`, `storeDocument`'s version stamp) is now fully exercised by every document
type in the system.

## The two-money-precisions mapping (the headline)

The quote prints money at TWO precisions against ONE `priceDecimals` knob, and the mapping is the
load-bearing decision:

- **`makeMoney(formats)` — fixed 2dp** — used for the setup charge, the minimum charge, and each
  price row's indicative extended amount. `priceDecimals` deliberately **does not reach it**: these
  are already-cent quantities, and a sub-cent setup charge changing at the golden gate is exactly the
  failure the split prevents. Grouping rides `thousandsSeparator`; the default is byte-for-byte
  today's `money()`.
- **`makeMoney4(formats)` — min 2dp, max `priceDecimals` (default 4)** — the SOLE consumer of
  `priceDecimals`, used for the unit price and the break prices. Quote prices are `Decimal(12,4)`;
  rounding a unit price to cents would misstate the agreement. Default (4) is byte-for-byte today's
  `money4()`.

Every money/money4 call site was grepped before the mapping. The pin (`tests/quote-templates.test.ts`,
"priceDecimals maps to unit/break prices ONLY") builds a row with `unitPrice 0.0525`, `setup 2`,
`minimum 100`, `break 0.0625`, `amount 102`, then moves the knob to 2: it asserts the unit price
(`$0.05`) and break (`$0.06`) round to cents WHILE `$2.00` / `$100.00` / `$102.00` are unchanged.
A 3dp case (`$0.055`) is also pinned. The two-money trap is also proven through the REAL print path
(`priceDecimals: 2` on an assigned template moves the unit price on paper; the setup stays `$2.00`).

## The footer retirement + purity join

The Phase 6 quote was the one sanctioned code-not-data carve-out: a hand-written `footer` page
callback printed "Page: N of M". Task 14 retires it to the declarative
`pageFooterSpec { kind: "pageNofM", label: "Page:" }` that `render.ts` (Task 6) turns into the
byte-for-byte same footer line — the callback's exact styling (`bold, fontSize 8.5, alignment
"right", margin [24,8,24,0]`) is reproduced by construction with label "Page:". Consequences:

- The quote builder **JOINS the JSON round-trip purity test** its seven siblings had — the definition
  is now plain JSON. `tests/quote-pdf.test.ts`'s documented footer exemption is removed (the file's
  header comment and `allText` comment updated; the footer-callback test replaced with one asserting
  `def.footer` is undefined and `def.pageFooterSpec` equals `{ kind: "pageNofM", label: "Page:" }`),
  and a purity round-trip test added.
- The printed "Page: N of M" stays byte-identical. Proven at the render level in
  `tests/quote-templates.test.ts` (a 16-line quote overflows to N pages and `drawnText` carries
  `Page: 1 of N` … `Page: N of N`), and the knob's OFF/ON behavior through the real print path.
- The QUOTE contract alone defaults `pageFooter` TRUE — golden compatibility with the page line the
  quote already prints.

## The intro/liability data seam

The two standing texts bind through the DATA SEAM (the cert's `cert_statement` shape, not the BOL's
config-literal shape): `quotes.ts` already reads them into `QuotePdfData`, so they are caller data,
not builder literals. `printQuote` injects the resolved config's `quote_intro_text` /
`quote_liability_text` at that seam; the builder still renders `input.introText` / `input.liabilityText`
verbatim — one source per fact, the pure-builder golden test intact. `quotePrintSettings` defaults the
two to the QUOTE contract's own text blocks, so a config-less `readQuotePdfData` (a preview/test) gets
the contract default.

## #97 — the indicative-amounts index-map guard

`indicativeAmounts` (`quotes.ts`) maps the engine's OPERATION lines back to price rows by array index.
The one-operation-per-input-row emission is `pricing.ts`'s contract today (even a $0 row pushes), but a
future engine change that filtered or reordered operations would turn `ops[i]` into misaligned money or
an out-of-bounds crash. Extracted the align+guard into a pure exported `alignOperationAmounts(prices,
ops, eachWeight)` that asserts `ops.length === prices.length` **before** the index map and throws naming
the mismatch; `indicativeAmounts` delegates to it. The guard is tested **both directions** on the pure
core (too-few and too-many ops throw; a matching count aligns, an LB row with no each-weight → null) —
no engine mocking, no DB.

## The settings retirement + the stranded-Setting finding

Every document builder is now a config-consumer and each standing text lives in its template's text
block (spec §8), so the four keys leave `settings.ts` and `settings-ui.ts`'s `TEXTAREA_KEYS`
(now empty; the mechanism stays for any future long-text setting). The two now-orphaned code defaults
(`CERT_STATEMENT_DEFAULT` / `SHIPPER_LIABILITY_DEFAULT`) are removed — the contract modules are the
canonical copy.

**Two vestigial readers had to be fixed** or cert/shipper printing would throw: `certPrintSettings`
and `ticketSettings` still called `getSetting("cert_statement")` / `getSetting("shipper_liability_text")`
(the value was read then overridden at the config seam). Both now default the text field to the
contract's own text block; `printCert` / `printShippingTickets` still replace it at the data seam from
the resolved config, unchanged. Verified by `tsc` (`getSetting` is typed to `SettingKey`, so any
remaining reader would be a type error) and by a source sweep (no `set/getSetting` of the four keys
remains anywhere in `src` or `tests`).

**Migration `20260813120000_retire_standing_text_settings`** is a data-only, idempotent `DELETE` of the
four orphaned `Setting` rows. Verified by re-reading Task 3's seed migration
(`20260812233950_seed_standard_templates`): all four values were `jsonb_set + COALESCE`-copied FROM
these Setting rows INTO the seeded template configs (cert_statement on CERT; shipper_liability_text on
BOTH SHIPPER and MOS_SHIPPER; quote_intro_text and quote_liability_text on QUOTE, the last with the
deliberate `'""'` empty-string fallback). So deleting the rows strands nothing.

**The stranded-Setting whole-branch check (Task 11 review carry):** the retirement does NOT strand a
value customized between Task 3's seed and this retirement, because on any real deployment BOTH
migrations ship in one release — no production install ever sees a customizable-then-retired window.
Stated as required. (The seed migration reads the live Setting at deploy time via COALESCE, so an
owner-edited value on an upgraded install is carried onto the seeded template; a fresh install falls to
the code default.)

## The overflow finding (investigate-first) — a continuation band IS warranted

A real quote genuinely overflows LETTER: `createQuote` requires min 1 line and imposes no max, and each
line is TALL (grid row + Material + a PRICE section of several centered detail lines). Probed
empirically: 16 lines each carrying one price row overflow to ≥2 pages. So a `continuationHeaderSpec` is
warranted, not dead code. The band repeats the quote number under the `quote_number` field's own label
plus "(continued)" (`overflowTopMargin: 40`), identity-locked (visibility flag ignored, label override
carries) like the invoice/BOL/cert/statement bands. Pinned through rendered bytes (page 1 clean, the
last page carrying "(continued)"). The pre-Task-14 quote had no band — this is a net improvement.

**Shared-mechanism boundary artifact (not quote-specific, reported not fixed):** the two-pass
`overflowTopMargin` render (render.ts, Task 6/8) can leave a spurious blank trailing page at isolated
boundary overflow counts — the same artifact Task 13 filed as **issue #102**. It affects every
overflow-capable converted document via its own latent boundary counts; the quote overflow test uses 16
lines, clear of any boundary. Cosmetic (no data loss), pre-existing, lives in shared render infra — not
fixed on-branch (the phase's cosmetic-defers-to-issue rule; #102 already tracks it).

## RED evidence (each cycle ran red before its implementation)

**Builder + print-path conversion** (`tests/quote-templates.test.ts` against the pre-conversion one-arg
builder + the un-resolved `printQuote` + the missing `alignOperationAmounts` export):
```
Tests  29 failed | 9 passed (38)
```
The 9 passes are golden-holding (they assert the DEFAULT reproduces today's paper, which the
unconverted builder already does — the invoice/statement pattern).

**Golden gate after the builder conversion** (both quote files, before the footer test was updated):
```
tests/quote-pdf.test.ts > ... renders 'Page: N of M' through the footer page callback
  → expected 'undefined' to be 'function'
Tests  1 failed | 62 passed (63)
```
Only the retired footer-callback test failed — every other golden default test passed, confirming
byte-compatibility. Updated to assert `pageFooterSpec` → 26/26 green.

**Settings retirement** (`tests/settings.test.ts`, "refuses the retired standing-text key", against the
un-retired registry):
```
expected undefined to be an instance of HttpError   (setSetting("cert_statement", …) still succeeded)
Tests  4 failed
```
After removing the keys → the four cases throw "Unknown setting" → green.

## Gate results (watched to completion)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2665/2665, 144 files** (Task 13 baseline 2624/143 — **+41**: `tests/quote-templates.test.ts` (38) + the quote-pdf/settings/settings-ui net) | 256.1s |
| `npx tsc --noEmit` | clean | — |
| `npx eslint src tests` | clean | — |
| `npm run build` | exit 0 (deferred until E2E finished — shared `.next`) | — |
| `npm run test:e2e` | **19/19 flows PASS, EXIT:0** — detached from the start with the PER-TASK sentinel `e2e-task14.done`; the run's own log shows 19 `PASS` lines, "All 19 flows passed" and "cleanup ok"; the `quotes` flow exercises the quote print path | ~9 min |
| `migrate status` (DEV `erp`) | up to date, **35 migrations** | — |
| `migrate status` (TEST `erp_test`) | up to date, **35 migrations** | — |

Dev-DB fixture hygiene: the E2E harness reported "cleanup ok"; pre/post the harness sweeps its own
E2E-prefixed rows (the established verification the prior five conversions relied on).

## Deviations

1. **`buildQuoteDefinition` now returns `RenderableDefinition`** (was `TDocumentDefinitions`) and takes
   `(input, config = QUOTE_DEFAULT_CONFIG, logoDataUri?)` — the structural superset carrying the two
   declarative spec keys (the invoice/cert/BOL/statement precedent). Callers and the golden suite
   type-check unchanged.
2. **The #97 guard is a small exported pure helper (`alignOperationAmounts`), not an inline throw.**
   The engine cannot naturally emit a mismatched op count (it's contractual), so the throw direction is
   untestable through the real path without mocking `priceOrder` (which would pollute the whole file).
   Extracting a pure core lets the guard be tested both directions with no mock and no DB — the repo's
   leaf-extraction convention; `indicativeAmounts` still "asserts before the index map" via the helper.
3. **`certPrintSettings` / `ticketSettings` changed** (beyond the quote): their vestigial reads of the
   retired keys are removed and the text fields default to the contract text block. Required — leaving
   the reads would make `getSetting` throw for cert/shipper printing once the keys left the registry.
   The seam override in `printCert` / `printShippingTickets` is unchanged.

## Notes for the UI tasks (15–21)

- **All eight contracts, builders, print paths and default configs are done and exercised.** The editor
  (Tasks 16–19) renders from the same `TemplateContract` shape every builder consumes; the QUOTE
  contract carries the two format quirks to surface in the editor — `pageFooter` default TRUE (the only
  contract) and `priceDecimals` default 4 (the only contract; every other is 2 or absent).
- **`TEXTAREA_KEYS` in `settings-ui.ts` is now empty** — no settings-page textarea keys remain; the
  long standing texts are edited in the template designer's text-block panels (Task 17), not the admin
  settings page. The carried Task-1 minor (`lockedElements` returns a flat section/field key list —
  tighten the namespace before rendering padlocks) still stands for Task 17.
- **The quote editor's text-block panel** edits `quote_intro_text` / `quote_liability_text` (the two
  QUOTE `textBlocks` entries); there is no longer any settings-page fallback for them.
- The carried Task-4/5 minors for Tasks 16/18/20/21 (getTemplate two-read window, editor save ABA,
  picker never-published projection, the stale CLAUDE.md handler sample) are unchanged by Task 14.
