# Task 7 report — Traveler conversion + the stamp plumbing

**Implementer:** fresh subagent, 2026-08-13
**Branch:** `phase-7-template-designer`
**Commits:** `a029266` (decoder lift + endstream guard), `b6144f9` (stamp plumbing),
`3c5cf30` (builder config consumption), `23e80d2` (print-path resolution + stamp)

## What landed

### 1. The stamp plumbing (`erp/src/server/documents.ts`, `b6144f9`)

`storeDocument(tx, owner, pdf, templateVersionId?)` — a fourth optional parameter written to the
`StoredDocument` row (`?? null`). Optional ONLY because the eight print paths convert one task at
a time; an unconverted caller's omission stores `null`, the exact pre-Phase-7 row shape (tested).
The stamp is metadata, so it rides inside the `auditedCreate` payload beside the owner columns —
the bytes still never reach the audit layer (tested: the payload carries the id, never `%PDF`).
`DocumentMeta`/`DOCUMENT_SELECT` deliberately unchanged — no list route's response shape moves;
the stamp is read off the row where it's needed. Tasks 8–14 just pass `resolved.versionId`.

### 2. The builder conversion (`erp/src/server/traveler.ts`, `3c5cf30`)

`buildTravelerDefinition(input, config = TRAVELER_DEFAULT_CONFIG, logoDataUri?)`:

- **The config lens.** `sectionView` resolves each config section against `TRAVELER_CONTRACT`
  once per build: section/field visibility (with the §5.6 belt — below), field order (the config
  array IS display order), `label: null` → contract `defaultLabel`, `width: null` → contract
  column `defaultWidth`. The builder ASSUMES completeness (the §5.3 backfill guarantees it) and
  re-defaults nothing — only the two null-means-default knobs a complete config still carries
  resolve here.
- **Sections**: the sheet stack is built by iterating `config.sections` in order; hidden →
  omitted; a renderer whose configurable content is entirely hidden returns `null` and drops.
- **The §5.6 builder belt**: `visible: sc.visible || !cs.hideable` (sections) and
  `(fc.visible) || !cf.removable` (fields) — the steps section, the header section, the typed
  step fields, and the barcode render REGARDLESS of the config's flags. No logging, just render
  (spec §5.6). Tests feed belt configs RAW (past the validator, which is separately asserted to
  refuse them).
- **Tables** (lines, quantities, inspections, steps): per-column cell producers keyed by field
  key; `widths`, header labels, and column order all assemble from the config's visible column
  fields. The steps title cell spans the leading run of content columns (default order = the
  mockup's exact colSpan-3 cell); typed step VALUES render inside the instruction column
  unconditionally (a locked rendering, not a column).
- **Fonts**: `defaultStyle { font: family, fontSize: baseSize }`; `headingSize` → the company
  name line; `smallSize` → the two sub-annotations (pieces-per-container, load weight).
- **Formats**: `makeNum(config.formats)` — the traveler's one knob, `thousandsSeparator`
  (`useGrouping`); no date or price ever prints (contract-scoped, per Task 1).
- **Logo** (spec §6.3): renders only when the resolved version carries BYTES **and** the config
  PLACES it; the node joins the TOP of its slot's stack (`header-left`/`center`/`right`) at the
  configured width and the stack reflows beneath. Either half missing → today's text-only
  header, byte-for-byte.
- **The Process: slot** (ruling 4, §5.7): binds the new `TravelerData.processName`, which
  `readTravelerData` reads LIVE off the lead part (`processName` added to the parts select) —
  deliberately outside the locked revision's freeze, with a test pinning the live binding
  (part edit after order creation changes the next collect). Blank prints nothing — the Phase 3
  blank-slot behavior exactly.
- **Purity unchanged**: sync, no I/O, no clock; the round-trip/determinism test extends to a
  non-default config + logo.

### 3. The print path (`erp/src/server/traveler.ts`, `23e80d2`)

Inside `printTraveler`'s existing transaction, after `claimOrder` + `assertPrintable`:
`resolveTemplateForPrint(tx, "TRAVELER", live.customerId)` (the claimed row already carries
`customerId` — no extra read), logo bytes → data URI by the STORED `logoMimeType`
(`jpegDataUri`/`pngDataUri`), build with the returned backfilled config, render, and
`storeDocument(..., resolved.versionId)`. **Isolation deliberately unchanged** — the §5.1
immutability argument is commented verbatim at the call site (correct at ANY isolation because
publish commits the immutable version row and the pointer move atomically; a print racing a
publish legitimately renders the previous published version — commit order, not wall clock; no
template claim, and the comment says not to add one).

### 4. The decoder lift (`erp/tests/helpers/pdf.ts`, `a029266`)

Task 6's PDF byte decoder (`pageCount`/`parseObjects`/`drawnPages`/`drawnText` + the `TINY_JPEG`
fixture) moved verbatim into `tests/helpers/pdf.ts` the moment this second suite needed it (the
Task 6 report's own note), **with the carried endstream guard**: a stream with no `endstream`
terminator now throws naming the object and offset instead of feeding `-1` into
`subarray`/`indexOf`. `tests/render-primitives.test.ts` imports from the helper; its 20 tests
pass unchanged. (The other Task 6 carried item — the `!== undefined` spec-collision cosmetic in
render.ts — was not taken: it is flagged cosmetic, no builder writes that shape, and it stays on
the carried list.)

## The golden-compat gate

**`tests/traveler.test.ts` passes UNCHANGED — zero edits to the file** (`git diff --stat` empty),
28/28 green through the new code path, alongside all seven other PDF suites (120 tests) and the
full 2383. **No Task 1 `DEFAULT_CONFIG` drift was found**: every label, width, font size, and the
format knob in the contract reproduced the builder's literals exactly — the seeded "Standard"
config renders today's paper through the converted builder with no correction migration needed.

## RED evidence (each step ran red before its implementation)

Stamp (4th argument ignored → row null / audit payload bare):

```
× a stored row carries the template version id it was given
  AssertionError: expected null to be 'standard-traveler-v1'
× the stamp rides in the audit payload as metadata — never the bytes
  AssertionError: expected undefined to be 'standard-traveler-v1'
```

Builder (config parameter ignored — 15 failures across every knob):

```
× a hidden section is omitted from the stack
× stack order follows the config's section order
× a hidden field drops its column — header cell and width both
× field order follows the config within its section
× a label override prints in place of the contract default
× a width override lands in the table's widths array
× thousandsSeparator: false ungroups every number the sheet prints
× family and role sizes map into the definition
× the switch is visible in the rendered bytes — embedded family + Tf size
× prints data.processName in the slot when set          (+ blank sibling)
× a placed logo joins the header-left/center/right slot (×3)
× readTravelerData — processName (×3, data.processName undefined)
```

Print wiring (template machinery not consulted — all 6 red):

```
× no assignment resolves the seeded Standard default and stamps ITS version id
× a customer-assigned template's PUBLISHED config prints — not the default — …
× a draft on the assigned template does NOT affect the print — §5.1 immutability …
× a placed PNG logo prints; the no-logo print carries the barcode alone
× a placed JPEG logo prints through the JPEG data-uri path
× uploaded logo bytes with no config placement stay off the paper
```

The resolution-wiring tests run the REAL services end to end: `createTemplate` → `editDraft` →
(`uploadLogo`) → `publishDraft` → `assignTemplate` → `printTraveler`, with assertions decoded
from the STORED bytes (`drawnText`) and the stamp read off the row — the immutability case opens
a real next draft, edits it a marker label, and proves the print still says the published "WO#",
never the draft marker, stamp unmoved.

## Gate results (watched to completion, from the runs' own output, on final HEAD `23e80d2`)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2383/2383, 137 files** (baseline 2352/136 — +31: this task's suite) | 238.8s |
| `npx tsc --noEmit` | clean | 1.9s |
| `npx eslint src tests` | clean | 9.3s |
| `npm run build` | exit 0 | compile 3.7s (warm) |
| `npm run test:e2e` | **19/19 flows PASS** — watched by the controller from the run's own log (`e2e-full.log`, sentinel confirmed), on the tree at `5e7b4b3` (this task's four commits + the quotes stale-gate fix) | full suite |

**The E2E story, on the record (controller-written):** the implementer's first run was SIGTERM-killed
mid-suite by its own shell teardown (7 flows green at the kill — the run was not detached; lesson
re-learned). The controller's re-run then failed **18/19 on `quotes`** — the same flow that flaked in
Task 6's run 1, now with a 45-second element-detached churn signature. Root-caused by a dedicated
debug agent as a **pre-existing Phase 6 defect**, not this task's doing and not test fragility:
`QuoteDetail.tsx`'s load effect had no stale-response gate, so StrictMode's dev double-mount left a
duplicate GET whose late response re-adopted pre-edit server truth over the in-flight draft, wiping
the Lines section mid-interaction (proven deterministically 2/2 → 0/2 with forced timing). Fixed in
`5e7b4b3` with the house stale-gate idiom; full record in `quotes-e2e-fix-report.md`. The 19/19 run
above is the first full pass after that fix; Task 6's "compile-pause" flake hypothesis is superseded
by this root cause. A sibling-page sweep for the same hole is queued as a background task chip.

## Config-mapping decisions (the ones a reviewer should weigh)

1. **`config` is a DEFAULT PARAMETER** (`= TRAVELER_DEFAULT_CONFIG`), not required. The golden
   gate demands the pre-existing suite pass UNTOUCHED, and that suite calls
   `buildTravelerDefinition(data)`. This is NOT the banned per-key re-defaulting: the default is
   the one complete canonical constant (§5.3's canonical copy — the same object the seeded
   Standard stores), never a reach for individual contract values at render time. The print path
   always passes the resolved config explicitly.
2. **The logo is a third parameter** (a data-URI string), not a `TravelerData` field:
   `TravelerData` is what `readTravelerData` assembles from the ORDER; the logo bytes belong to
   the resolved template VERSION, so they travel beside the config they arrived with. The
   builder stays pure — conversion (bytes → data URI, mime-typed) happens in the print path.
3. **Hand-laid sections map order within structure.** Header: field order applies WITHIN each of
   the three column slots (left: customer/received-from; center: the company block; right: the
   number columns); a field never migrates between columns; the barcode is always the right
   slot's last text-block element. Footer: fields group into the rows they anchor
   (tempered_results, final_inspection, pass+fail, tested_by+tested_date, ok_to_ship+ship_date);
   a group renders when any member is visible (the hidden half leaves an empty spanned cell so
   its sibling holds position), groups sort by their earliest visible member's config position,
   and the left RESULTS box keeps its hand-tuned 151pt against the DEFAULT right column.
4. **Value-only fields ignore label overrides.** A field whose `defaultLabel` is `""` (customer
   name, the address lines, the step typed-value rendering) has no label ELEMENT on this paper —
   an override has nothing to replace and prints nothing new. Inventing a label slot would be
   layout the contract never promised.
5. **The customer line's 9.5pt stays a builder literal** — between base and heading, covered by
   neither font role.
6. **`config.pageFooter` is deliberately unconsumed** (commented in the builder): the traveler
   contract pins it false (golden compat), and Task 8's sheet groups own the traveler's
   page-number/continuation story (#36/#43) — with the note that `pageNofM` needs ≥ ~28pt bottom
   margin (the traveler's is 24pt today; Task 8 must widen it if it wires the footer).
7. **The steps title span is reorder-safe**: the "PROCESS STEPS:" cell spans the leading
   contiguous run of content columns (exactly the mockup's colSpan-3 under default order); a
   config interleaving a handwriting column into that run gets plain empty header cells past the
   title's run instead of a broken span.

## Deviations

1. The brief's suggested test shape "the stored row carries the id / omitting stores null" was
   extended with a third stamp test (the audit-payload assertion) — the house
   metadata-never-bytes rule applied to the new column.
2. `countImages` (test-side) counts non-SMask image XObjects: a PNG with alpha embeds as image +
   `/SMask` pair, so the naive `/Subtype /Image` count read 2 for one barcode. Discovered
   mid-task; the helper counts pictures on paper, not XObjects in the file (commented).
3. Nothing else — no scope beyond the brief; per-load sheet groups, #36, #43 untouched (Task 8).

## Notes for Task 8 (sheet groups build directly on this)

- `buildTravelerDefinition` already builds per-sheet: the sheet loop assembles a `blocks` stack
  per load through `renderSection(key, ctx, sheet)`. Splitting into one definition per load is a
  refactor of that loop's tail (one `content` per sheet instead of `pageBreak: "before"`),
  feeding `renderSheetGroups` — `ctx` is sheet-independent and reusable across groups.
- The continuation header's per-load static content (order number, load number, barcode) is
  exactly `headerBlock`'s right-slot material; `d.barcodeDataUri` is already a data URI.
- `pageFooterSpec` needs a bottom margin ≥ ~28pt — the traveler's `pageMargins` are
  `[24, 24, 24, 24]`; widen the bottom when wiring `config.pageFooter`, and mind golden compat
  (the seeded config keeps `pageFooter: false`, so the default path must keep margin 24 or prove
  the change invisible).
- The byte decoder is in `tests/helpers/pdf.ts` now (with `TINY_JPEG`); `pageCount` survives the
  pdf-lib merge (`useObjectStreams: false`).
- The #43 bound belongs BEFORE `readTravelerData`/render inside the claimed transaction (count
  loads cheaply, refuse with the named 400) so the order-row lock never spans an unbounded
  render.
- `printTraveler` now has the resolution + stamp in place — Task 8 changes only the render call
  shape (`renderPdf(one def)` → `renderSheetGroups(defs)`), leaving resolution and
  `storeDocument(..., resolved.versionId)` as they are.

## E2E fixture hygiene

To be verified after the E2E run completes (dev-DB counts for `E2E%`/`e2e_%` fixtures — recorded
below the final gate row).
