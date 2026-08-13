# Task 2 report — The billing-side contracts (cert, invoice, statement, quote)

**Implementer:** fresh subagent, 2026-08-12
**Branch:** `phase-7-template-designer`
**Commits:** `2b3a37a` (the carried machinery fix: section-hide counts as hiding its fields),
`eca1c9a` (the four billing-side contracts + registry + machinery knob extensions + tests)

## What was built

- **`erp/src/lib/template-contracts/{cert,invoice,statement,quote}.ts`** — the four billing-side
  contracts, same client-safe pure-declaration rules as Task 1 (zero `src/server/**` imports;
  settings literals copied verbatim; the one cross-import is `src/lib/ar-constants.ts`, itself a
  pure client-safe constants module). Each ends in `DEFAULT_CONFIG = defaultConfig(CONTRACT)`.
- **`index.ts`** — all eight contracts registered in `CONTRACTS`; the unregistered-docType error
  path retested with a cast `"POSTING_REGISTER"` (spec §2's explicit ninth-document refusal).
- **`types.ts`** — three machinery changes:
  1. **The Task 1 review carry (routed here):** `assertLocksHonored` now treats hiding a section
     as hiding its fields — a *hideable* section sheltering a non-removable field is refused,
     naming the field and quoting its `lockReason`. Both directions tested (the sheltered locked
     field refuses the section-hide; the same section with the field removed from the contract
     hides fine; an all-removable hidden section is not over-refused). The check reads the
     CONTRACT's fields, ordered after the section's own hideable check, so Task 1's traveler
     pins (steps/header refusals) kept their original messages — zero regressions.
  2. `NEGATIVE_STYLES` becomes ruling 3's real picker: `["SIGN_AFTER_SYMBOL", "LEADING_MINUS",
     "PARENTHESES"]` (was the unused Task 1 placeholder pair `["MINUS", "PARENTHESES"]` — no
     contract had declared the knob yet and the only test reference was `"PARENTHESES"`, which
     survives; no existing test touched). `SIGN_AFTER_SYMBOL` is today's `$-937.44` — the 5A
     ruling, sign between the `$` and the digits.
  3. `TemplateContract` gains optional `pageFooter?: boolean` (absent = false), consumed by both
     `defaultConfig` and `configSchema`'s zod default — so the quote's `pageFooter: true` holds
     in DEFAULT_CONFIG **and** the §5.3 backfill by construction (`validateConfig("QUOTE",
     {}).pageFooter === true`; a post-hoc spread onto the derived default would have let an empty
     stored config silently backfill to false). The Task 1 `tableBudgets` precedent: machinery
     grows when a real contract forces it.
- **`erp/tests/template-contracts.test.ts`** — 62 → 93 tests (+31), written RED-first per cycle.
  `REGISTERED` updated to eight; the registry-wide loops (unique keys, lock reasons,
  DEFAULT_CONFIG validation/round-trip) now sweep all eight contracts; the loop's pageFooter
  assertion became `toBe(docType === "QUOTE")`.

## RED evidence (the rule from Task 1's review)

Cycle 1 — the lock fix's dangerous direction, before the `types.ts` change:

```
 FAIL  tests/template-contracts.test.ts > section-hide counts as hiding its fields (the Task 1
       review carry) > refuses hiding a hideable section that shelters a non-removable field,
       quoting the FIELD's lock
AssertionError: expected function to throw an error, but it didn't
 ❯ tests/template-contracts.test.ts:236:62
      Tests  1 failed | 2 passed | 62 skipped (65)
```

Cycle 2 — the contract tests, before the four modules existed:

```
 FAIL  tests/template-contracts.test.ts > the contract registry > registers exactly the eight
       contracts, under their own docTypes
AssertionError: expected [ 'BOL', 'MOS_SHIPPER', …(2) ] to deeply equal [ 'BOL', 'CERT',
       'INVOICE', …(5) ]
 FAIL  tests/template-contracts.test.ts > the cert contract > declares the builder's blocks in
       stack order
TypeError: Cannot read properties of undefined (reading 'sections')
      Tests  32 failed | 61 passed (93)
```

## Contract-derivation decisions per document

**Cert** (from `buildCertDefinition`): nine sections in stack order — `header`, `parties`,
`parts` (partsTable [70,\*,90], the double-spaced part-identity head preserved), `statement` (a
ZERO-FIELD section rendering the `cert_statement` text block — the shipper `liability`
precedent; default copied verbatim from `settings.ts`'s `CERT_STATEMENT_DEFAULT`),
`requirements` (three value-only data slots: the ruling-27 multi-part heading, the
specification/scale line, the readings grid), `serials` (label root "Serial Numbers"; the
builder's "— {part}:" composition is glue), `freeform` (the §7.4-sanctioned printable half),
`signature` (a section with the four printed pieces — mark/name/title/company; rendering
semantics stay the builder's, Task 11 consumes), `footer` (the static per-page strip). **Internal
no-print notes appear nowhere** — no field, no section, no text block; the test sweeps every
key and editor name for `/internal/i` and the two literal key spellings. §3.21's other
exclusions are already enforced by `CertPdfData` carrying no min/max/pass-fail/override — the
contract can only bind what the data layer collects. Knobs: `thousandsSeparator` +
`dateFormat: "MM/DD/YYYY"` (`paddedDate`); no money prints, so the price knobs are off the
surface (test pins a `priceDecimals`-carrying config as refused). Fonts Roboto 9/19/7.5.
`lockedElements` = `[]` — the cert's protection is omission, not a lock.

**Invoice** (from `buildInvoiceDefinition`): nine sections in stack order — `header` (the title
is DATA, the row's own kind, so its field is value-only with `defaultLabel: ""` — one contract
covers credits, spec §4.1), `identity` (no Page No. — the recorded 5A deviation stands until
Task 6's primitive), `parties` ("Billto:"/"Shipto:", the sample's own spellings), the
`column_header` strip (table `columns` [52,\*,66,84] — the ONE place the document's grid widths
live; everything beneath is free-flow text the builder aligns to the same constants, so the
body fields are value-only and the budget counts each width once), `order_strip`, `parts`,
`price` (incl. the Phase 6 `quote_source` line, label root "Quote", off the FROZEN
`sourceQuoteNumber`), `totals` (the five named data-description rows are value-only), `footer`
("Contact: Accounts Receivable" is a pure label — overridable, no data behind it). **The
frozen-columns walk:** the test declares `INVOICE_FIELD_SOURCE`, a map from every contract field
key to a `keyof InvoicePdfData` (or the explicit `"(label-only)"` sentinel), compile-checked
with `satisfies` against a type-only import of `InvoicePdfData` — a field naming a source the
data layer doesn't collect fails `tsc`, and a contract key without an entry fails the runtime
walk. `company`/`remitTo` map legitimately: they are keys of `InvoicePdfData` (the two
sanctioned live identity reads, spec §4.2). Knobs: `negativeStyle: "SIGN_AFTER_SYMBOL"` (the
first real declarer; editable — a PARENTHESES round-trip is tested), `priceDecimals: 2`,
`thousandsSeparator`, `dateFormat: "MMM D, YYYY"`. Fonts Roboto 9/20/7.5.

**Statement** (from `buildStatementDefinition`): six sections in stack order — `header` (the
title here is a LABEL, "Statement" — nothing kind-varies it), `identity`, `open_items`,
`aging`, **`finance_charge` and `total` as separate sections** (the brief's explicit shape — the
finance line prints only when a run assessed one and must be hideable independently of the
total). The **aging labels are referenced from `AGING_BUCKET_LABELS`** in `ar-constants.ts` —
the builder prints from the same constant, so contract and paper cannot drift; the test pins
the en-dash "1–30" so a duplicated ASCII "1-30" can never sneak in. The **open-items columns
carry no width knob**: the builder's widths are `["auto","auto","auto","*","*"]` — content-sized,
a hand-laid choice the machinery's `number | "*"` column type deliberately doesn't model (the
traveler process-row precedent); label/visibility knobs only. The aging strip's seven columns
are all `"*"` (exactly today's `Array(7).fill("*")` — flex widths count 0 toward the budget).
Knobs: `negativeStyle` IS declared (credit/payment rows print negative money through the same
`money()`), `priceDecimals: 2`, `thousandsSeparator`, `dateFormat: "MMM D, YYYY"`. Fonts
Roboto 9/20/**9** — no fine print smaller than the base prints today, so the small role starts
pinned to the base size (a conversion task gives it a slot).

**Quote** (from `buildQuoteDefinition`): seven sections in stack order — `header`, `parties`,
`intro` (zero-field, renders `quote_intro_text`), `column_header` (table `columns` [52,\*,66,84];
"Total Lbs / Price"), **`lines` as ONE section** (grid row, Material, PRICE heading and price
rows interleave PER LINE — unlike the invoice's document-level parts-then-prices split, they
cannot be two independently ordered sections), `closing` (ending statement, printable notes,
the ruling-14 signature pieces), `liability` (zero-field, renders `quote_liability_text`). Text
blocks copied from `settings.ts`: `quote_intro_text` = "We are pleased to provide you with the
following quotation:"; `quote_liability_text` = `""` — **ships empty deliberately** (the owner
keys the shop's wording; the builder omits the strip when blank, so the empty default IS
today's paper). **`pageFooter` defaults TRUE for the quote alone** — its builder's footer
callback prints "Page: N of M" today, and golden compatibility means reproducing THAT; the
test pins DEFAULT_CONFIG, the `{}`-backfill agreement, and that the knob still turns off.
**`priceDecimals: 4`** (`money4` — ruling Q7's accepted deviation as the default, now editable;
a `2` override round-trips). No `negativeStyle` — no negative money ever prints on a quote, and
a config carrying the knob is refused (the Task 1 knob-surface rule). The lowercase "Setup
charge:"/"Minimum charge:" (vs the invoice's title case) are preserved exactly, per document.
`dateFormat: "MM/DD/YYYY"` (`paddedDate`). Fonts Roboto 9/20/6.5.

**Shared decisions.** Trailing label-value whitespace ("Invoice No.:&nbsp;&nbsp;" vs "Invoice
Date:&nbsp;") is alignment glue, not label content — labels are pinned without it (Task 1's own
convention, e.g. the ticket's "Order No.:"); internal double-spacing inside a label (the part
identity heads) IS content and is preserved. `"MMM D, YYYY"` is the fixed `DATE_FORMATS` set's
token for the long "July 29, 2026" style the invoice's and statement's `longDate` prints —
Task 1's set was built to cover every printed style and this is its only long-date member; the
token→rendering mapping is Tasks 12/13's job. Composed labels (the invoice/quote "Price per
{unit}:", the quote's "{n} or more:", the cert's "Serial Numbers — {part}:") declare the
overridable label root; the data glue stays the builder's.

## Deviations from the brief

1. **`NEGATIVE_STYLES` values replaced, not extended.** The brief's minimum trio
   (`sign-after-symbol`, `leading-minus`, `parentheses`) landed as
   `SIGN_AFTER_SYMBOL`/`LEADING_MINUS`/`PARENTHESES` (the house UPPER_SNAKE enum style Task 1
   set with `"PARENTHESES"`); Task 1's placeholder `"MINUS"` was renamed to `LEADING_MINUS`
   rather than kept alongside — it was declared by no contract and referenced by no test, and
   keeping both would put two names on one rendering.
2. **The contract type grew `pageFooter?: boolean`** (not in the brief's machinery list) —
   forced by the quote's true-default: setting it anywhere but the contract would break the
   "backfill and DEFAULT_CONFIG cannot disagree by construction" invariant (§5.3). The Task 1
   `tableBudgets` precedent.
3. **Prescribed existing-test edits only**: `REGISTERED` to eight, the "exactly four" registry
   test retitled, the unregistered-docType test re-pointed at a cast `"POSTING_REGISTER"` (all
   eight real types are now registered, so the error path needs a value outside the union), and
   the registry loop's pageFooter assertion became per-type. Every other Task 1 test is
   byte-untouched and green.
4. **The statement declares `negativeStyle`** though the brief named the knob only for the
   invoice — credit/payment rows print negative `money()` on statements, and leaving the knob
   off would freeze their rendering while the invoice's became editable. Consistent with the
   Task 1 knob-surface rule (knobs exist exactly where the rendering exists).

## Gate results (watched to completion, from the runs' own output)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2226/2226, 131 files** (baseline 2195/131 — +31 tests, all this task's) | 206.7s |
| `npx tsc --noEmit` | clean | 1.9s |
| `npx eslint src tests` | clean | 9.2s |
| `npm run build` | exit 0 | 16.9s |
| E2E | not run — no UI/function/flow touched (pure `src/lib` + tests; nothing imports the new modules yet), per the brief | — |

## Notes for Task 3 (schema, migrations, seeds)

- The seed migration's per-type SQL config literals are the eight `DEFAULT_CONFIG`s
  (`defaultConfigFor(docType)` serialized). Mind the encoding: `shipper_liability_text` carries
  a real `\n\n` (JSON-encode it in the literal), the statement's aging labels carry the en-dash
  "1–30" (UTF-8), and the BOL's eleven text blocks carry the transcription quirks — the §10
  drift-guard must deep-equal all of it.
- **The quote's seeded v1 config must carry `pageFooter: true`** — it is the one non-false
  default, and a seed literal built from a stale "all false" assumption would fail golden compat
  at Task 14's gate.
- The four standing-text keys whose live `Setting` rows the seed copies (subquery,
  code-default fallback) map to: `cert_statement` (CERT), `shipper_liability_text` (BOTH
  SHIPPER and MOS_SHIPPER configs), `quote_intro_text` + `quote_liability_text` (QUOTE). Note
  `quote_liability_text`'s code default is the EMPTY string — the fallback must produce `""`,
  not omit the key (`.strict()` textBlocks would still backfill it, but the drift guard compares
  the literal).
- `validateConfig`/`defaultConfigFor` throw on nothing now — all eight types are registered, so
  Task 4's service can dispatch on the Prisma enum values 1:1 against `TEMPLATE_DOC_TYPES`.
- The section-hide lock fix means a future contract may mark a locked field's section
  `hideable: true` and the machinery still refuses the hide — but the traveler's
  steps/header stay non-hideable as declared (belt and braces, both tested).
