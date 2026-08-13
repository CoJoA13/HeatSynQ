# Task 10 report — BOL conversion

**Implementer:** fresh subagent, 2026-08-13
**Branch:** `phase-7-template-designer`
**Commits:** `e93a8c3` (pre-step comment fix), `9c1152a` (builder config-consumer + text blocks),
`c40872f` (print-path resolution + stamp)

## Pre-step (carried from Task 9's review)

`erp/src/server/shippers.ts` ~:1890 — the docType-count comment said "Counted under the claims,"
but `shipmentOrderIds` reads BEFORE the lock statements. Rewritten to name the actual mechanism:
the transaction's **Serializable snapshot, fixed at the stub read**, is what keeps the count and
every read the render uses mutually consistent — a concurrent add/remove either misses the
snapshot entirely or SSI aborts one side. Comment only; no code change (`e93a8c3`).

## What landed

### 1. The builder conversion (`erp/src/server/pdf/bol.ts`, `9c1152a`)

`buildBolDefinition(input, config = DEFAULT_CONFIG, logoDataUri?)` → `RenderableDefinition` — the
ticket's exact lens applied to the BOL's single contract: `sectionView` per section, views
resolved over `completeSections(BOL_CONTRACT, config.sections)` (the §5.6 omission belt), config
array order = display order, `label: null` → contract default, `width: null` → contract column
default (the freight table's five columns against its 386pt sidebar-adjusted budget).

- **THE ELEVEN UDSBL CONSTANTS ARE GONE FROM THE BUILDER.** They render from
  `config.textBlocks` now (spec §8: the template designer is the legal text's editing path); the
  contract's `defaultText` transcriptions — quirks intact — are the only remaining copy, and the
  seeded Standard carries them, so the default paper is unchanged (golden holding). Both
  directions pinned: an edited block reaches paper (each of the eleven individually, one sweep
  test), the default text no longer prints beside it. A third belt half was added for the one
  config surface `completeSections` does not cover: `ctx.text(key)` falls back to the CONTRACT's
  `defaultText` when a raw config omits a text-block key — a validated config always carries all
  eleven (zod defaults), but the builder must never print the string "undefined" (tested).
- **THE DATE-STYLE GREP RESULT (the brief's required finding): the BOL prints ONE date style.**
  `grep -n "bolDate\|MONTHS\|Date(" src/server/pdf/bol.ts` before conversion: `bolDate` was
  declared once and called exactly ONCE — line 208, the ship-from line. No second date call
  exists anywhere in the builder, so the contract's single knob (default "MMM - DD - YYYY", the
  sample's own "Jul - 06 - 2026") maps to that slot directly — no two-styles trap to honor here,
  and the header comment says so. All five fixed styles tested; the default pinned.
- **Fonts/formats:** `defaultStyle` from family/baseSize; `headingSize` → "STRAIGHT BILL OF
  LADING" (15); `smallSize` → the SIX 5.5pt fine-print clauses (received, property, water,
  value, liability, fibre) — the 6pt clauses (certifies, section-7, no-delivery, imprint) and
  the 7pt declared-value statement keep their own literals, the ticket's two-date-styles rule
  generalized to sizes: the knob maps to exactly the slots the contract's default reproduces.
  `thousandsSeparator` drives `num()` (weight + package count).
- **Hand-laid mappings** (the traveler's decision-3 discipline, each documented in code): the
  header's two structural slots (title left, four labeled form rules right) order fields WITHIN
  their slot and never migrate between them; the consigned block's fields keep the sample's
  fixed positions, each dropping its label+rule pair when hidden; the delivering-carrier line
  likewise; hiding `collect_checkbox` drops the box AND its explanatory caption; a hidden
  signature half leaves its slot holding position (the ticket parties' treatment); inter-block
  rules are each section's own closing glue and hide/travel with it. The form's small inline
  furniture (captions, "RECEIVED $", the "at"/"From" connectives) stays builder-rendered, per
  the contract's own header comment; `ship_from` is a value-only composite field (label
  overrides have nothing to replace — traveler decision 4).
- **Logo** (spec §6.3): header-left/right unshift into their slots; the sample header has no
  center slot, so **header-center materializes a middle column** between the two structural
  slots — only a placed logo changes the structure (golden: no logo → today's two-column header).
- **§5.6 belt, both halves:** nothing on this contract is locked, so the flag expression's
  testable duty is the NEGATIVE direction (a validated config may hide any section — tested);
  the omission half is real (raw configs omitting a section entry or a field entry still render
  them, both shapes tested), plus the text-block half above.

### 2. The overflow finding (the brief's investigate-first item) — the band IS warranted

**The BOL genuinely overflows one page on a live data path.** Two facts, both verified:

1. `createShipper`'s input schema bounds every scalar (`freightDescription` max 200,
   PO/pro/SCAC max 30) but the **orders array is `z.array(SHIP_ORDER).min(1)` with NO max** —
   a many-order shipment is legal, and `readBolData` maps every order into `orderNumbers` (the
   TRV line) and `poNumbers` (the Consignee's Ref rule), both of which wrap.
2. Probed empirically against the pre-conversion builder before writing any code: 5 orders → 1
   page, 40 → 1 page, **80 → 2 pages**, 120 → 2, 200 → 2 (the lists wrap slowly past that).

So the `continuationHeaderSpec` is NOT dead code and was added per the ticket pattern: the
band repeats the BOL's identity — its `bolNumber` under the `bol_number` field's label (the
BOL's one number of its own, §3.19) — plus "(continued)", `overflowTopMargin: 40` (text-only
band; only an overflowing BOL pays the reserve, render.ts's two-pass keeps a one-page BOL's
margins byte-identical). Label override carries, visibility flags deliberately ignored (identity
on paper is locked — the ticket band's treatment; both halves tested). The overflow itself is
pinned through rendered bytes: an 80-order BOL is ≥2 pages, page 1 clean, page 2 carrying
"Shipper's Bill of Lading No. 12795" + "(continued)".

### 3. Page N of M

`config.pageFooter` (default OFF — the BOL contract sets no `pageFooter`, so the backfill
default is false, golden: margins `[24,24,24,24]` asserted) → `pageFooterSpec: {kind:
"pageNofM"}` + the house 44pt bottom margin. Knob-on prints "Page 1 of 1" through the real
print path (tested); the default print carries no page numbers (tested).

### 4. The print path (`erp/src/server/shippers.ts`, `c40872f`)

Inside `printBol`'s existing Serializable transaction, with the claim order untouched (stub →
`claimOrdersInOrder` → `claimShipperRow` → `assertPrintable`):

- **The lazy §3.19 allocation is byte-identically untouched** — same statements, same position;
  first print allocates, reprint reuses, regression pinned WITH stamps on both stored rows.
- `resolveTemplateForPrint(tx, "BOL", shipper.customerId)` after the allocation — **no docType
  ternary**: the BOL is one per shipment and the registry has no MOS_BOL. Count-independence is
  pinned explicitly: one test prints a single-order AND a two-order shipment against the same
  assigned marker template — both style alike and stamp the same version id (the ticket's
  docType would have flipped to MOS_SHIPPER on the second).
- Logo bytes → data URI by stored mime type (the ticket pattern verbatim);
  `renderPdf(buildBolDefinition(data, resolved.config, logoDataUri))` — ONE
  `RenderableDefinition`, no sheet groups (single-document paper, per Task 9's note);
  `storeDocument(..., resolved.versionId)` stamps the row (the store at the old ~:2054).

## RED evidence (each cycle ran red before its implementation)

Builder conversion (config parameter ignored — 30 of 37 new tests failed):

```
× a label override prints in place of the contract default
× a width override lands in the freight table's widths array
× a hidden section is omitted from the stack — its glue rides with it
× a hidden field drops its freight column — header cell and width both
× hiding the collect checkbox drops the box AND its explanatory caption
× stack order follows the config's section order
× field order follows the config WITHIN the header's form-rule slot
× hiding a signature half leaves its slot holding position; …
× family, base size and role sizes map into the definition
× thousandsSeparator: false ungroups the weight and package count
× renders the ship-from date as M/D/YYYY          [+ MM/DD/YYYY, YYYY-MM-DD, MMMM D, YYYY]
× an edited text block reaches the paper; the default no longer does
× every one of the eleven blocks is config-fed — editing each moves the paper
× nothing on this contract is locked: … the builder honors it
× a placed logo joins the header-left/right/center slot (×3)
× the pageFooter knob turns on the footer spec and widens the bottom margin
× the definition carries the BOL's identity band for continuation pages
× the band carries a label override but ignores the visibility flags
× a many-order shipment's BOL overflows LETTER and repeats its identity on page 2
× printBol … (all 6 print-path tests)
 Tests  30 failed | 7 passed (37)
```

(The 7 passes were structurally vacuous pre-implementation: the "MMM - DD - YYYY" style and the
default-style test pass against the unconverted builder's own literal; the three omission-belt
shapes pass against a builder that ignores config entirely — they exist to pin the
`completeSections`/fallback choices once the builder DOES consume config; plus the no-logo
fallback and the round-trip.)

Print path (template machinery not consulted — all 6 red after the builder commit, e.g.):

```
× no assignment: … stamps ITS version id           → expected null to be 'standard-bol-v1'
× docType is count-independent: …                  → drawnText missing 'BOL-STYLE-MARKER'
× an assigned template's edited legal text prints  → missing 'CONFIG-RECEIVED-MARKER'
× the pageFooter knob prints per-page numbers      → missing 'Page 1 of 1'
× a placed logo prints through the real path       → expected [ +0 ] to deeply equal [ 1 ]
× the lazy §3.19 allocation … both stamp           → expected null to be 'standard-bol-v1'
 Tests  6 failed | 31 passed (37)
```

The resolution tests run the REAL services end to end (`createTemplate` → `editDraft` →
(`uploadLogo`) → `publishDraft` → `assignTemplate` → `printBol`), with assertions decoded from
the rendered bytes (`drawnText`/`drawnPages`/`paintedImageCounts`) and the stamp read off the
stored row.

## The golden-compat gate

**`tests/bol.test.ts` passes UNCHANGED — zero edits to the file**, 16/16 green through the
converted code path, alongside `shipping-ticket.test.ts`, `shipping-ticket-templates.test.ts`,
`shippers.test.ts`, `shipper-routes.test.ts`, `shipper-void.test.ts`, `documents.test.ts`,
`order-ship-invariants.test.ts`, `template-seed.test.ts` and `template-contracts.test.ts`
(315 tests across the neighbor run). No `DEFAULT_CONFIG` drift surfaced: every label, width,
font size, both format knobs and all eleven text-block transcriptions in the contract reproduced
the builder's literals exactly. The default-config content stack is node-for-node today's (14
content items, same shapes) — the definition's only additions are the two declarative spec keys.

## Gate results (watched to completion, from the runs' own output, on final HEAD `c40872f`)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2486/2486, 139 files** (Task 9 baseline 2449/138 — **+37**: this task's suite) | 261.7s |
| `npx tsc --noEmit` | clean | 1.9s |
| `npx eslint src tests` | clean | 11.2s |
| `npm run build` | exit 0 | — |
| `npm run test:e2e` | **19/19 flows PASS** — run detached from the start with the PER-TASK sentinel `e2e-task10.done` (Task 9's process note, now the rule), result read from the run's own log (`e2e-task10.log`: the full per-flow results block, "All 19 flows passed", harness "cleanup ok", `EXIT:0`) | ~10 min |

**E2E fixture hygiene:** pre-run dev-DB counts 0/0/0/0 across all four fixture prefixes
(`Customer.code LIKE 'E2E%'`, `User.username LIKE 'e2e_%'`, `Role.name LIKE 'E2E%'`,
`ProcessStepCode.code LIKE 'E2E%'`); post-run direct check against the DEV database (`erp`):
**0/0/0/0 again**, alongside the harness's own "cleanup ok".

## Config-mapping decisions (the ones a reviewer should weigh)

1. **The builder binds to `config.textBlocks` directly** — the opposite of the ticket's
   liability-through-data seam, deliberately. Task 9's notes suggested the data seam, but the
   analysis behind decision 2 there doesn't transfer: the ticket's liability text was already
   CALLER DATA (`TicketData.company.liabilityText`), so binding its builder to config would have
   created two sources for one fact and broken the golden pure-builder test. The BOL's legal
   text was never data — it was the builder's own constants (the form itself) — so the config IS
   its one source, the config-less golden call renders `DEFAULT_CONFIG`'s transcriptions
   (identical text), and threading eleven strings through `BolData` would have changed that
   type's shape for nothing. The Task 10 brief's own wording ("render from the config's text
   blocks; delete the in-file constants") confirms this reading.
2. **`ctx.text()`'s contract-default fallback** (the omission belt's text half) — one map built
   from `BOL_CONTRACT.textBlocks`, no literal duplicated. Same rationale as `completeSections`;
   unreachable through stored configs (zod defaults every key), tested through the raw shape.
3. **header-center logo materializes a middle column** — the sample's header has only two
   structural slots; a placed center logo is the one thing that adds a third. No logo → the
   structure is byte-for-byte today's.
4. **`smallSize` maps to the six 5.5pt clauses only** — the 6pt/7pt clause literals stay
   literals (the knob-maps-to-what-the-default-reproduces rule; documented at `receivedBlock`
   and `bottomBlock`).
5. **Inter-block rules are section glue** — each full-width rule hides and travels with the
   section it closes (header, received, trv). A reordered section carries its rule.

## Deviations

1. **`buildBolDefinition` now returns `RenderableDefinition`** (was `TDocumentDefinitions`) — the
   structural superset carrying the two declarative spec keys; every existing caller and the
   golden suite type-check unchanged.
2. **The Task 9 note's data-seam suggestion for the UDSBL text was not followed** — see
   config-mapping decision 1; the brief's explicit instruction governs.
3. Nothing else — no scope beyond the brief; cert untouched (Task 11), `settings.ts` untouched
   (Task 14).

## Notes for Task 11 (cert — the last shipment-side paper)

- **`cert_statement` is a Setting-backed text block like the ticket's liability text was** — the
  data-seam vs config-binding fork returns. Check where `readCertData`/cert assembly sources the
  statement TODAY: if it arrives as caller data (the ticket shape), inject the config's block at
  the data seam (Task 9's decision 2); if it's a builder literal (the BOL shape), bind to
  `config.textBlocks` (this task's decision 1). The two worked examples now bracket both cases.
- **The cert contract omits internal notes entirely** (spec §5.6: "nothing to lock — the field
  list never offers them"); the plan wants the contract-omits-internal-notes test riding against
  the real data path in Task 11.
- **Signature block semantics untouched** (the plan's own words) — treat the signature image the
  way this task treated the lazy BOL allocation: byte-identical, regression-pinned.
- **Multi-part certs stay ONE sheet group** (plan Task 11 Step 2) — `renderPdf` on one
  `RenderableDefinition`, this task's shape, not the ticket's plural.
- The per-task sentinel discipline (`e2e-task11.done`) is now the rule — never reuse a sentinel
  filename across tasks.
