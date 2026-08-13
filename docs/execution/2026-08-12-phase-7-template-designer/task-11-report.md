# Task 11 report — Cert conversion

**Implementer:** subagent (successor), 2026-08-13. The previous implementer was terminated by a
transient 529 after landing ONE commit; this report covers the finish.
**Branch:** `phase-7-template-designer`
**Commits:**
- `238cfbd` — **INHERITED** (sound, built on): `render.ts`'s `pageFooterSpec` gained an optional
  static `above` field so a per-page company strip can ride the pageNofM knob instead of competing
  for pdfmake's single `footer` slot (+2 render-primitives tests). This is Task-6 infra; the cert
  builder consumes it (below).
- `d307194` — `buildCertDefinition` becomes a config-consumer; `cert_statement` binds at the data
  seam (builder-side + the whole `tests/cert-templates.test.ts`).
- `efb8fe8` — `printCert` resolves the CERT template, binds `cert_statement` from config, stamps
  the version.

## The binding-shape finding (the brief's data-seam-vs-config fork)

**`cert_statement` binds through the DATA SEAM — the TICKET shape, not the BOL shape.** The fork
turns on what the code does TODAY, and `certs.ts` reads the Setting (`getSetting("cert_statement")`)
into `CertPrintSettings.statement`, which `readCertPdfData` puts into `CertPdfData.statement`
(`certs.ts:639`). The statement is therefore **caller data**, exactly as the ticket's liability
text was (`TicketData.company.liabilityText`) — not a builder literal like the BOL's eleven UDSBL
constants were. So:

- The **builder** keeps reading `input.statement` verbatim (no `config.textBlocks` binding in
  `buildCertDefinition`). Binding it to config would create two sources for one fact and break the
  pure-builder golden test (`buildCertDefinition(sampleCert())` must render the statement the data
  carries — `tests/cert-pdf.test.ts` passes its own distinctive statement string).
- The **config binding happens in `printCert`**, at the seam: the setting-backed
  `settings.statement` is replaced by `resolved.config.textBlocks.cert_statement` in the object
  handed to `readCertPdfData`. This is the ticket's `shippers.ts:1918` pattern
  (`liabilityText: resolved.config.textBlocks.shipper_liability_text`) applied verbatim.
- Both directions are pinned through the real print path: an edited config block reaches paper, and
  a DISTINCT marker written to the Setting does NOT (the template designer owns the statement;
  `settings.ts` untouched until Task 14 retires the key).

The `statement` contract section is a text-block section with no fields of its own (the
shipper-liability precedent); the builder renders the whole section, hideable, and the text is the
data seam's.

## The overflow finding (the brief's investigate-first item) — the band IS warranted

**A real cert genuinely overflows one page on multiple live paths.** Probed empirically against the
pre-conversion builder BEFORE writing any code:

| driver | live bound | pages |
|---|---|---|
| readings under one requirement | `z.array(READING).max(500)` (cert-results.ts; "the owner's real sample carries 27") | 27→1, **100→2**, 300→3, 500→4 |
| parts (order lines) | `z.array(LINE).min(1)` — **NO max** (orders.ts:204) | 2→1, **10→2**, 20→4, 30→5 |
| serials | `z.array(SERIAL_ITEM).max(10_000)` (orders.ts) | **50→2**, 200→4, 500→8 |

So the `continuationHeaderSpec` is NOT dead code (contrast: it is added per the BOL pattern). The
band repeats the cert's identity — `Order No.: <orderLabel>` under the `order_no` field's label
(§10.3's own header field) plus "(continued)", `overflowTopMargin: 40` (a text-only band; only an
overflowing cert pays the reserve — render.ts's two-pass keeps a one-page cert's 24pt top margin
byte-identical). The `order_no` label override carries; visibility flags are deliberately ignored
(identity on paper is locked — the BOL band's treatment; both halves tested). The overflow itself
is pinned through rendered bytes: a 150-reading cert is ≥2 pages, page 1 clean, the last page
carrying "(continued)".

## What landed

### 1. The builder conversion (`src/server/pdf/cert.ts`, `d307194`)

`buildCertDefinition(input, config = DEFAULT_CONFIG, logoDataUri?)` → `RenderableDefinition` — the
BOL's exact lens on the cert's nine sections: `sectionView` per section, views resolved over
`completeSections(CERT_CONTRACT, config.sections)` (the §5.6 omission belt), config array order =
display order, `label: null` → contract default, `width: null` → contract column default (the parts
table's three columns against the full 564pt content width).

- **Labels/widths/visibility/order** all config-driven, per section: the header's two hand-laid
  slots (centered title stack, right order-fields stack — fields order within a slot, never migrate
  between them, the BOL header decision); the parties `to`-box + PO/packing/material right stack;
  the parts table columns; the requirement spec-line/readings grid; the serials label root; the
  freeform block; the signature block; the footer strip.
- **Fonts:** `defaultStyle` from family/baseSize; `headingSize` → the "Certification" title (19pt);
  `smallSize` → the footer strip's 7.5pt fine print. The requirement grids' 9.5pt and the
  signature/parties literals stay literals — the knob-maps-to-what-the-default-reproduces rule
  (the BOL's generalized two-styles discipline).
- **THE DATE FINDING (the brief's required grep):** `paddedDate` was the SOLE date renderer, with
  exactly TWO call sites — the Date and Entry Date header slots — **both printing MM/DD/YYYY**. So
  unlike the ticket (two *different* styles), the cert has ONE style across two slots: the
  contract's single `dateFormat` knob (default "MM/DD/YYYY") maps to both directly. All five styles
  tested on both slots; the default pinned.
- **`num()`** drives thousands grouping on the parts' qty and pounds (`thousandsSeparator`).
  `reading()`'s 1-to-4-decimal rendering is DATA PRECISION, not a knob (the cert carries no
  price-decimals surface) — a pure literal function, left uncoupled from config.
- **Logo** (spec §6.3): header-left fills the sample's 100pt left spacer (its own logo area);
  header-center/right unshift into the title/order-field stacks. No logo → today's spacer-left
  header, byte-for-byte.
- **§5.6 belt, both halves:** nothing on this contract is locked, so the flag expression's testable
  duty is the NEGATIVE direction (a validated config may hide any section — tested); the omission
  half is real (`completeSections` — a raw config omitting a section/field entry still renders it,
  both shapes tested). No text-block belt half here — `cert_statement` binds at the data seam, not
  through the builder.

### 2. The three untouchables (all preserved and pinned)

- **§3.21's type-level exclusion** — `CertPdfData` still carries no min/max/pass-fail/override/
  per-reading structure. The conversion added no field and no binding the contract does not declare;
  a config can only rearrange what the data layer collects. The existing contract-omits-
  internal-notes test (`cert-pdf.test.ts`, real data path) stays green and unedited — the
  internalNotes seam did not move (only the statement seam did, and it stays inside `printCert`).
  Added: a builder-level test that even a fully re-labelled config over a cert whose reading FAILS
  its band prints no verdict furniture.
- **The signature block** — **byte-identical under the default config**, pinned two ways: a
  definition-level deepEqual of the whole signature node to its exact pre-conversion shape (image/
  typed-name over the rule, name/title/company lines, margins), AND through rendered bytes (the
  image paints — `paintedImageCounts([1])`; the typed-name fallback paints none — `[0]` — with the
  name still drawn). Each printed piece is a config-gated field, structured so the default (all
  visible) emits the identical node tree.
- **Multi-part certs are ONE sheet group** — `renderPdf` on one `RenderableDefinition`, never
  plural. The ruling-27 frozen-identity grouping is UNCHANGED: `part_heading` only gates the
  heading's visibility; the `lineIdentity` comparison that decides a group boundary is untouched.
  The Phase 4 frozen-requirements / `orderLineIdAtSeed` grouping / multi-part-heading suites
  (`cert-pdf.test.ts`, `cert-results.test.ts`, `certs.test.ts`) stay green and unedited.

### 3. Page N of M (`config.pageFooter`, default OFF — golden)

The cert ALWAYS carried a per-page company strip (`footer`), so its bottom margin is 44 today (not
the BOL's 24) — the knob does not change the margin, only where the strip and the count go. Knob
OFF (default): the strip is a plain static `footer`, exactly today (pinned). Knob ON: the strip
rides the pageNofM footer's `above` slot (the reason the inherited `238cfbd` added it), stacked
over the page line by render.ts's one callback, and the plain `footer` is dropped (render.ts refuses
both). Footer section hidden + knob ON → the page line alone. All tested; per-page numbers pinned
through the real print path, the default print carrying none.

### 4. The print path (`src/server/certs.ts`, `efb8fe8`)

Inside `printCert`'s existing Serializable transaction, after the existing claims
(`claimCertsOrder` → re-read → `assertPrintable` on the cert AND the owning order):

- `resolveTemplateForPrint(tx, "CERT", owner.customerId)` — **no docType count split**: a cert is
  ONE per scope instance and the registry has no MOS_CERT (unlike the ticket's SHIPPER/
  MOS_SHIPPER). `owner`'s select widened to carry `customerId` alongside the `deletedAt` the void
  check already read.
- `cert_statement` bound at the data seam: `readCertPdfData(tx, certId, { ...settings, statement:
  resolved.config.textBlocks.cert_statement }, signer, printDate)`.
- Logo bytes → data URI by stored mime type (the BOL pattern verbatim), rendered only when the
  config places one.
- `renderPdf(buildCertDefinition(data, resolved.config, logoDataUri))` — ONE definition.
- `storeDocument(..., resolved.versionId)` stamps the row (the §5.2 stamp).
- **`printedAt` first-print semantics and the signer read are byte-identically untouched** —
  regression pinned (first print sets it, reprint does not move it; both prints stamp the version).

## RED evidence (each cycle ran red before its implementation)

Builder conversion (config parameter ignored — 30 of 42 tests failed against the one-arg builder):

```
× a label override prints in place of the contract default
× a width override lands in the parts table's widths array
× a hidden section is omitted from the stack
× a hidden field drops its parts column — header cell and width both
× a hidden non-column field drops from its block
× stack order follows the config's section order
× field order follows the config WITHIN the header's order-fields slot
× family, base size and role sizes map into the definition
× thousandsSeparator: false ungroups the parts' quantity and pounds
× renders both header dates as M/D/YYYY  [+ YYYY-MM-DD, MMMM D, YYYY, MMM - DD - YYYY]
× nothing on this contract is locked: … the builder honors it
× renders whatever statement the data carries; the statement section can be hidden
× hiding the part_heading field drops the headings but keeps the grouped grids
× a placed logo joins the header-left spacer / header-center / header-right (×3)
× the knob ON moves the company strip onto the pageNofM footer's `above` slot
× the knob ON with the footer section hidden carries the page line alone
× the definition carries the cert's identity band for continuation pages
× the band carries an order_no label override but ignores its visibility flag
× a reading-heavy cert overflows LETTER and repeats its identity on page 2
× printCert … (all 6 print-path tests)
 Tests  30 failed | 12 passed (42)
```

(The 12 passes were the golden-holding tests — they exist to STAY green through the conversion:
the signature byte-pin and the pageFooter-OFF static-footer default pass against the unconverted
builder BY DESIGN; the two omission-belt shapes and the §3.21-exclusion pass against a builder that
ignores config entirely; plus the MM/DD/YYYY default, the multi-part heading default, the
no-logo fallback, and the purity round-trip.)

Print path (template machinery not consulted — all 6 red after the builder commit):

```
× no assignment: … stamps ITS version id            → expected null to be 'standard-cert-v1'
× a label override prints through the real path      → drawnText missing 'CERT-STYLE-MARKER'
× the config's cert_statement reaches paper …        → missing 'CONFIG-STATEMENT-MARKER'
× the pageFooter knob prints per-page numbers        → missing 'Page 1 of 1'
× a placed logo prints through the real path         → expected [ 0 ] to deeply equal [ 1 ]
× printedAt is set on the first print only … stamps  → expected null to be 'standard-cert-v1'
 Tests  6 failed | 36 passed (42)
```

The resolution tests run the REAL services end to end (`createTemplate` → `editDraft` →
(`uploadLogo`) → `publishDraft` → `assignTemplate` → `printCert`), decoding assertions from the
rendered bytes (`drawnText`/`drawnPages`/`paintedImageCounts`) and reading the stamp off the stored
row.

## The golden-compat gate

**`tests/cert-pdf.test.ts` passes UNCHANGED — zero edits to the file**, 36/36 green through the
converted code path, alongside the Phase 4 cert suites (`cert-results` 353, `certs` 662,
`cert-routes` 337, `cert-list` 190, `cert-resolution` 184, `certs-schema` 387) and
`documents`/`template-seed`/`template-contracts` — 276 tests across the ten neighbor files, all
unedited. No `DEFAULT_CONFIG` drift surfaced: every label, width, font size, both format knobs and
the one text-block transcription reproduced the builder's literals exactly, and the default content
stack is node-for-node today's.

## Gate results (watched to completion, on final HEAD `efb8fe8`)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2530/2530, 140 files** (Task 10 baseline 2486/139 — **+44**: this task's 42 + the inherited render's 2) | 297.6s |
| `npx tsc --noEmit` | clean | 5.1s |
| `npx eslint src tests` | clean | 12.1s |
| `npm run build` | exit 0 | — |
| `npm run test:e2e` | **19/19 flows PASS** — run detached from the start with the PER-TASK sentinel `e2e-task11.done`, result read from the run's own log (`e2e-task11.log`: 19 `PASS` lines, "All 19 flows passed", harness "cleanup ok", `EXIT:0`) | ~10 min |

**E2E fixture hygiene:** pre-run dev-DB counts 0/0/0/0 across all four fixture prefixes
(`Customer.code`/`User.username`/`Role.name`/`ProcessStepCode.code`); post-run direct check against
the DEV database (`erp`) **0/0/0/0 again**, alongside the harness's own "cleanup ok".

## Config-mapping decisions (the ones a reviewer should weigh)

1. **`cert_statement` binds at the data seam** (the ticket shape) — the opposite of the BOL's
   config-literal binding, deliberately, because the statement is already caller data. See the
   binding-shape finding above.
2. **The `footer` section is a page-margin strip, not a content-flow section** — it is pulled out
   of the content loop and renders in the footer slot regardless of its position in the config's
   section order (only its visibility and its two fields' labels apply). A page footer is inherently
   a margin element; reordering it in the section list does not move it into the body.
3. **The bottom margin is 44 unconditionally** (not the BOL's default-24-widen-to-44) — the cert
   has always carried a per-page strip, so 44 is today's value; the pageFooter knob changes only
   where the strip and the count go, keeping the default byte-identical.
4. **The signature block honors per-field visibility but is byte-identical by default** — the four
   signature fields gate visibility (a config could hide the title line), structured so the
   all-visible default emits the exact pre-conversion node tree. The labels are value-only ("") —
   a label override has nothing to replace (the BOL's `ship_from` decision).
5. **`reading()` stays a pure literal, uncoupled from config** — the readings' 1-to-4-decimal
   precision is data, not a knob; the cert contract carries no price-decimals surface.

## Deviations

1. **`buildCertDefinition` now returns `RenderableDefinition`** (was `TDocumentDefinitions`) — the
   structural superset carrying the two declarative spec keys; every existing caller and the golden
   suite type-check unchanged.
2. Nothing else — no scope beyond the brief; `settings.ts` untouched (Task 14), the invoice/credit
   left for Task 12.

## Notes for Task 12 (invoice/credit — the frozen-snapshot conversion + `processNames` + #98)

- **The invoice is the OPPOSITE snapshot rule from the cert/shipper** (CLAUDE.md, ruling 24's
  refinement): `Invoice`/`InvoiceLine`'s identity and pricing fields are read UNCONDITIONALLY from
  their snapshot columns — never re-joined to the live source. There is no live-join-first-with-
  fallback branch to reach for (a draft edit replaces the whole line array — §5.5). The config
  conversion must not introduce one; the builder maps config over the FROZEN snapshot data.
- **`invoice_statement`/text-block binding shape:** check where the invoice builder sources any
  standing text TODAY — the cert's data-seam fork returns. The two worked examples now bracket both
  (BOL = config literal; ticket/cert = data seam).
- **The company strip `above` infra is already in place** (`238cfbd`) — Task 12's invoice per-page
  strip reuses it exactly as the cert does here.
- **`processNames` source change + #98** are Task 12's own scope (per the brief) — not touched here.
- The per-task sentinel discipline (`e2e-task12.done`) is the rule — never reuse a sentinel
  filename across tasks; run detached from the start; clear dev-DB fixtures; defer `npm run build`
  until E2E finishes (they share `.next`).
