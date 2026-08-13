# Task 9 report — Shipping ticket + MOS conversion, tear-off reflow

**Implementer:** fresh subagent, 2026-08-13
**Branch:** `phase-7-template-designer`
**Commits:** `3a3be12` (builder config-consumer, both contracts), `444acae` (tear-off reflow +
`textRunsWithY`), `0f2f3a5` (per-ticket sheet groups), `83d18a7` (print-path resolution + stamp)

## What landed

### 1. The builder conversion (`erp/src/server/pdf/shipping-ticket.ts`, `3a3be12`)

ONE builder, BOTH contracts: `buildShippingTicketDefinition(input, docType = "SHIPPER",
config = DEFAULT_CONFIGS[docType], logoDataUri?)`. The `docType` names which contract the
backfilled config was validated against, and every label/width/lock resolution runs against THAT
contract's map — the two contracts are structurally identical today but free to diverge (spec
§4.1), so the builder never resolves a MOS config against the SHIPPER declaration or vice versa.
The traveler's exact lens: `sectionView` per docType, views resolved over
`completeSections(CONTRACTS[docType], config.sections)` (the §5.6 omission belt, the Task 8
helper copied in two lines), config array order = display order, `label: null` → contract
default, `width: null` → contract column default.

- **THE TWO-DATE-STYLES TRAP (BINDING, honored):** `makeHeaderDate(formats)` is the date knob's
  ONLY consumer and feeds the header's Ship Date slot alone; the tear-off's "Shipped ON:" calls
  the un-knobbed `paddedDate` with a trap comment at both sites. One test carries both
  assertions (knob moves the header, provably NOT the tear-off), plus a five-style sweep with
  the tear-off asserted unchanged under every style.
- **The §5.6 belt, both halves:** the flag expression is the traveler's verbatim — and since
  NOTHING on these contracts is locked (shipper.ts's own header), its testable duty is the
  NEGATIVE direction: a validated config may hide any section and the builder honors it
  (tested). The omission half is real: raw configs omitting a section entry or a field entry
  still render them (tested both shapes).
- **Fonts/formats:** `defaultStyle` from family/baseSize; `headingSize` → the document title
  (the `title` field's label IS its printed text, so a label override renames the paper);
  `smallSize` → the liability fine print; `thousandsSeparator` drives both number styles
  (`makeNum`/`makeNum2`). Value-only fields (company name/address/phone) ignore label overrides
  — the traveler's decision 4.
- **Hand-laid mappings** (the traveler's decision-3 discipline, each documented in code): header
  fields order WITHIN their three slots and never migrate between them; the two party boxes fill
  left/right in config order with a hidden box leaving its slot holding position; tear-off
  fields group into the three rows they anchor, groups sort by earliest visible member, hidden
  members leave empty slots. The containers fold prints its visible columns TWICE (the 282pt
  budget's shape) — a hidden column drops from both groups (tested).
- **Logo** (spec §6.3): bytes+placement → the node joins the TOP of its header slot at the
  configured width; either half missing → the text-only header (tested).
- `packingListNo`'s six-digit zero-pad stays a builder literal — a formatting rule of the paper,
  not a knob.

### 2. The tear-off reflow (`444acae`) — the technique chosen

`absolutePosition: {x: 24, y: 648}` is GONE. The strip is now a flow node: an `unbreakable`
stack behind a fixed 16pt gap after the last content block. Long tables and width overrides
reflow the strip (to the next page when it no longer fits) instead of running under it, and
`unbreakable` keeps the strip whole across page breaks — the flow-safe replacement for what the
absolute pin incidentally provided. **Bottom-pinning was considered and rejected** (documented at
the renderer): pdfmake has no flow-safe "push to page bottom" — a stretching spacer needs the
content's measured height, and render.ts's two-pass precedent reserves MARGIN space (it cannot
push flowed content down without measuring it). Accepted deviation from the sample: a sparse
ticket's strip sits below the totals rather than at the page's bottom edge; the golden gate sees
only content, which is unchanged.

The regression test decodes RENDERED bytes with positions: `tests/helpers/pdf.ts` gains
`textRunsWithY` — per-page decoded runs with device-space x/y read off pdfkit's
`q / flip-cm / BT / Tm` brackets (the stream's outer flip and the inner one cancel, so the Tm
translation IS the run's baseline; verified against a flowed node and an absolutePosition node
before writing the helper). Deliberately ADDITIVE beside `drawnPages` — that decoder is
load-bearing for every content assertion in the suite and was not touched. The test pins: on any
page the strip shares with part rows, every row sits strictly ABOVE the strip's top (device y),
the strip never precedes rows in page order, and no `absolutePosition` appears in the definition.
A second fixture (24 rows) pins the positive flow shape — the strip SHARES its last page with the
table's tail, rows strictly above it (noted: that one is a pin, not a RED discriminator).

The RED fixture is honest about the mechanism: with the default section set, the trailing blocks
(containers/liability/totals) break to a new page before part rows can reach the strip's slot, so
the fixture hides the trailing sections through a VALIDATED config (nothing is locked) — the
layout a long pick list legitimately produces, and the regime the HANDOFF §7 item 5.3 ping
describes ("past ~8 extra multi-line part rows").

### 3. Per-ticket sheet groups (`0f2f3a5`)

`buildShippingTicketDefinitions(...)` → `RenderableDefinition[]`, one per order's ticket, merged
by `renderSheetGroups` in the print path — the traveler's Task 8 shape with the shared-half
discipline (`prepareTickets` feeds both builders; a test pins the plural's stacks equal to the
singular's, so per-ticket content cannot drift). Each definition carries ITS order's
`continuationHeaderSpec` (order label + "(continued)"; label override honored, visibility flags
deliberately ignored — the traveler band's identity-is-locked treatment, tested both ways) with
`overflowTopMargin: 40` (a text-only band; only overflowing tickets pay the reserve), and
`config.pageFooter` (default OFF — golden, margins `[24,24,24,24]` asserted) adds the per-group
`pageNofM` spec and widens the bottom margin to the house 44pt. The singular builder stays as the
legacy whole-document view and golden oracle (the Task 8 keep, reviewer-accepted precedent).

### 4. The print path (`erp/src/server/shippers.ts`, `83d18a7`) — the resolution wiring

Inside `printShippingTickets`' existing Serializable transaction, with the claim ORDER untouched
(stub read → `claimOrdersInOrder` → `claimShipperRow` → `assertPrintable`):

- **docType by the SHIPMENT'S order count**, read from the same `shipperOrderIds` list the claims
  used: `> 1 → MOS_SHIPPER`, else `SHIPPER`. The count is the shipment's, never the tickets being
  printed — the per-order ticket of a multi-order shipment resolves MOS_SHIPPER (spec §5.2, all
  paper from one shipment styles alike; tested explicitly as the third resolution case). Counted
  under the claims, so a concurrent add/remove cannot flip the type mid-print.
- `resolveTemplateForPrint(tx, docType, shipper.customerId)` on the claimed tx — §5.1
  immutability-not-locking, the printTraveler comment restated at the call site; logo bytes →
  data URI by stored mime type (the traveler pattern verbatim).
- **Liability from the CONFIG** (spec §8): the resolved config's `shipper_liability_text` text
  block is injected at the `readShippingTicketData` settings seam
  (`{ ...settings, liabilityText: resolved.config.textBlocks.shipper_liability_text }`), so the
  `Setting` no longer reaches ticket paper while `settings.ts` stays untouched (Task 14 retires
  it) and the golden collector path still reads it. See "config-mapping decisions" below.
- `renderSheetGroups(buildShippingTicketDefinitions(data, docType, resolved.config,
  logoDataUri))`; the render-bound comment states the #43-style discipline: the group count is
  the shipment's own order count — bounded by the very rows this transaction already claimed.
- `storeDocument(..., resolved.versionId)` — the stamp on every stored row (asserted on all five
  print shapes the tests archive).

## RED evidence (each cycle ran red before its implementation)

Builder conversion (config parameter ignored — 18 of 22 new tests failed):

```
× a label override prints in place of the contract default (SHIPPER)   [+ MOS_SHIPPER]
× a width override lands in the table's widths array (SHIPPER)         [+ MOS_SHIPPER]
× a hidden section is omitted from the stack
× a hidden field drops its column — header cell and width both
× a hidden container column drops from BOTH folded groups
× stack order follows the config's section order
× field order follows the config within its section
× the two party boxes follow config order …
× family, base size and role sizes map into the definition
× thousandsSeparator: false ungroups every number style …
× moves the header date and provably NOT the tear-off date
× every fixed date style renders in the header; the tear-off never follows
× nothing on this contract is locked: … the builder honors it
× a placed logo joins the header-left/center/right slot (×3)
 Tests  18 failed | 4 passed (22)
```

(The 4 passes were structurally vacuous pre-implementation: the two omission-belt tests pass
against a builder that ignores config entirely — they exist to pin the `completeSections`-vs-raw
choice once the builder DOES consume config — plus the no-logo fallback and the round-trip.)

Tear-off reflow (against the committed absolutePosition builder, the exact overlap signature):

```
× the definition carries no absolutePosition anywhere
× a part table reaching the strip's old fixed slot reflows instead of running under it
  → expected 98.220313 to be greater than 127.794922     ← a row at device y≈98 UNDER the
 Tests  2 failed | 1 passed                                 strip's top at y≈128
```

Sheet groups (the plural builder absent):

```
× … 5 tests → (0 , buildShippingTicketDefinitions) is not a function
```

Print path (template machinery not consulted — all 8 red):

```
× no assignment: … stamps ITS version id            → expected null to be 'standard-shipper-v1'
× no assignment: a multi-order shipment stamps …    → expected null to be 'standard-mos-shipper-v1'
× customer-assigned templates: the three resolution cases … → … to contain 'SINGLE-STYLE-MARKER'
× the seeded Standard's text block prints …         → … to contain 'INSTITUTE'
× an assigned template's edited text block prints   → … to contain 'CONFIG-LIABILITY-MARKER'
× the pageFooter knob restarts numbering per ticket group … → … to contain 'Page 1 of 1'
× a ticket overflowing LETTER repeats its order identity …  → … to contain '(continued)'
× a placed logo prints through the real path …      → expected [ +0 ] to deeply equal [ 1 ]
```

The resolution tests run the REAL services end to end (`createTemplate` → `editDraft` →
(`uploadLogo`) → `publishDraft` → `assignTemplate` → `printShippingTickets`), with assertions
decoded from the rendered bytes (`drawnText`/`drawnPages`/`paintedImageCounts`) and the stamp
read off the stored row.

## The golden-compat gate

**`tests/shipping-ticket.test.ts` passes UNCHANGED — zero edits to the file**, 22/22 green
through the converted code path, alongside `bol.test.ts`, `cert-pdf.test.ts`,
`shipper-routes.test.ts`, `shipper-void.test.ts`, `shippers.test.ts`, `documents.test.ts` and
the Phase 4 snapshot/released-row suite `order-ship-invariants.test.ts` (165 tests across the
neighbor run) — the snapshot-fallback paths flow through `readShippingTicketData`, which this
task did not touch. No `DEFAULT_CONFIG` drift surfaced: every label, width, font size and both
format knobs in the contracts reproduced the builder's literals exactly.

## Gate results (watched to completion, from the runs' own output, on final HEAD `83d18a7`)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2449/2449, 138 files** (Task 8 baseline 2411/137 — **+38**: this task's suite) | 252.2s |
| `npx tsc --noEmit` | clean | 1.8s |
| `npx eslint src tests` | clean | 10.0s |
| `npm run build` | exit 0 | compile 4.2s (warm) |
| `npm run test:e2e` | **19/19 flows PASS** — run detached with a sentinel from the start, result read from the run's own log (`e2e-full.log`: the full per-flow results block + "All 19 flows passed" + harness "cleanup ok") | ~7 min |

**E2E fixture hygiene:** pre-run dev-DB counts 0/0/0/0 across all four fixture prefixes
(`Customer.code LIKE 'E2E%'`, `User.username LIKE 'e2e_%'`, `Role.name LIKE 'E2E%'`,
`ProcessStepCode.code LIKE 'E2E%'`); post-run direct check against the DEV database (`erp`):
**0/0/0/0 again**, alongside the harness's own "cleanup ok".

**Process note (for the next brief's E2E discipline):** the shared scratchpad accumulates
sentinel/log files across tasks (`e2e-full.done` from an earlier task's run sat beside this
run's `e2e-done.sentinel`), and a successor polling a stale name would read a finished-looking
sentinel from the WRONG run. This run's names matched and the watcher fired correctly; future
runs should mint per-task sentinel names (e.g. `e2e-task10.sentinel`) so a takeover can never
match a predecessor's artifact.

## Config-mapping decisions (the ones a reviewer should weigh)

1. **`docType` is the builder's second parameter, defaulting `"SHIPPER"`,** with `config`
   defaulting to that docType's own `DEFAULT_CONFIG` (a default-parameter expression referencing
   the earlier parameter). The golden gate demands the existing suite's
   `buildShippingTicketDefinition(input)` calls keep rendering today's paper; the print path
   always passes all of docType/config/logo explicitly. This is Task 7's decision 1 with the
   docType axis added — NOT per-key re-defaulting.
2. **The liability text flows through `TicketData.company.liabilityText`, sourced from the
   config by the PRINT PATH** — the builder does not read `config.textBlocks` directly.
   Deliberate, and the alternative was weighed: binding the builder to the config's text block
   would make the config-less legacy call print the contract's literal instead of the caller's
   data, breaking the golden pure-builder test — and the only escape would be argument-presence
   sniffing (`config === undefined ? data : config`), a two-sources-in-one-renderer shape.
   Instead the builder keeps one source per fact and the path that owns resolution injects the
   template's text at the data seam (one line; the preview path does the same with a draft
   config). Both directions are pinned through the real path: an edited Setting no longer
   reaches paper, an edited text block does.
3. **The banner and the strip's rows are hand-laid, order applying where a row exists**: the
   totals banner renders first when visible (its config position does not move it above/below
   the pair — one hand-laid block); tear-off groups sort by earliest visible member (the
   traveler footer's exact mechanic).
4. **The continuation band ignores visibility flags** (the traveler Task 8 deviation-3
   treatment, applied as precedent): `order_no` is removable on the SHEET, but a continuation
   page separated from its ticket still names its order. Label override carries through. Both
   halves tested.
5. **The ticket contracts lock nothing, so the §5.6 flag belt is exercised in the negative
   direction only** — the expression is present (the traveler's verbatim), and the test pins
   that it does NOT force what the contract allows hiding; the omission half is fully
   observable and tested in both shapes. There is no positive flag-belt case to write until one
   of these contracts locks an element.

## Deviations

1. **The reflow regression fixture hides the trailing sections through a validated config**
   rather than using the default section set. Found during RED tuning: with every section
   visible, pdfmake breaks the trailing blocks to a new page before part rows can reach the
   strip's old fixed slot, so the default-shape "overlap" is between the strip and the
   totals/liability blocks — real, but not cleanly assertable (those texts also appear
   elsewhere). The hidden-sections fixture reproduces the ping's actual mechanism (the part
   TABLE reaching the strip) with unambiguous markers. The structural
   no-absolutePosition assertion covers every shape.
2. **`textRunsWithY` added to `tests/helpers/pdf.ts`** (shared test infrastructure) — additive
   only; `drawnPages` untouched. The brief's "or equivalent" allowed a weaker assertion, but
   reading order IS position order exactly when absolutePosition is involved, so the honest
   decode needed y.
3. **No §5.1 draft-immutability re-test for the ticket.** Task 7 pinned that behavior through
   `resolveTemplateForPrint` itself (draft edited after publish, print unmoved); the ticket path
   calls the same function on the same claimed-tx shape, and re-proving it per docType would pin
   the mechanism eight times over. Flagged for the reviewer to rule on.
4. Nothing else — no scope beyond the brief; BOL untouched (Task 10), `settings.ts` untouched
   (Task 14).

## Notes for Task 10 (BOL — same shipment paper)

- **The order-count rule is already decided and wired**: `printShippingTickets` computes
  `docType` from `shipperOrderIds` under the claims. The BOL is ONE per shipment, so if its
  docType is just `BOL` (it is — the contract registry has no MOS_BOL), no count is needed;
  copy the resolution + stamp block from `printShippingTickets` (`83d18a7`) without the docType
  ternary.
- **The BOL's date style** "MMM - DD - YYYY" is already in `DATE_FORMATS` and in this builder's
  `makeHeaderDate` sweep — the BOL contract's default should pin it, and the golden gate will
  catch any drift. Check whether the BOL prints ONE date style or two before mapping the knob
  (the ticket's trap generalizes: map the knob to exactly the slots the contract's default
  reproduces, leave any second style its own literal).
- **The liability-through-data seam is the worked example** for the BOL's UDSBL legal text:
  source the config's text block into the settings/data object in the print path; don't bind the
  builder to `config.textBlocks` (decision 2 above tells the why).
- `buildShippingTicketDefinitions` + `renderSheetGroups` is the sheet-group shape; the BOL is
  single-document, so `renderPdf` on one `RenderableDefinition` with `pageFooterSpec` behind the
  knob (and `continuationHeaderSpec` if the BOL can overflow) is enough.
- `textRunsWithY` exists now for any position-order assertion; it is pdfkit-Tm-shaped (no Td/TD
  chasing) — if a future renderer changes the emission shape, extend it rather than trusting
  zeros.

## E2E fixture hygiene

To be completed from the detached run's log and a post-run dev-DB count (below, after the
sentinel).
