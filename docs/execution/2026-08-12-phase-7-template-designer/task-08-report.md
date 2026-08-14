# Task 8 report — Traveler sheet groups: #36 continuation headers + #43 the all-loads bound

**Implementer:** third subagent, 2026-08-13 (see "Double takeover" below)
**Branch:** `phase-7-template-designer`
**Commits:** `efac8c2` (the omission-belt pre-step, agent 1), `50e09dc` (`overflowTopMargin`, the
two-pass render, agent 1), `eb718ac` (the ToUnicode decoder's ligature bug + `paintedImageCounts`),
`6643621` (#36 — one definition per load), `8538cab` (#43 — the 100-load bound)

## Double takeover — what I inherited and what I did with it

Two previous implementers were terminated mid-task by an infrastructure error, not by anything
wrong with their work. State at handover:

- **Committed and sound:** `efac8c2` and `50e09dc`. I read both in full and kept them unchanged.
- **Uncommitted WIP (322 insertions, agent 2):** the print-path wiring (`prepareSheets`,
  `continuationHeader`, `buildTravelerDefinitions`, `printTraveler` → `renderSheetGroups`), the
  `paintedImageCounts` test helper, and nine tests. Agent 2's last act was reporting "tsc is
  clean"; it never ran a test suite.

**Verification, not adoption.** `npx tsc --noEmit` was indeed clean. The four-file targeted run
was **not**: 193 passed, **1 failed** — the overflow continuation-header test, decoding page two as
`'tEOd#xxCxG#txM#n1OtsPQehgrwpeler bwxd…'` instead of containing `Order Number 1000`. That failure
is what commit `eb718ac` is about (below); it was a real bug in shared test infrastructure, not in
agent 2's wiring.

**Kept from the WIP** (reviewed line by line, all now test-covered and green): the `prepareSheets`
split, the identity band, `buildTravelerDefinitions`, the `printTraveler` render-call change, and
all nine tests. **Reworked / added by me:** the decoder fix + its own regression test; the `#43`
bound entirely (constant, refusal, four tests); one more #36 test (the band ignores the visibility
flags — the WIP asserted that behavior in a comment but nothing pinned it); the fixture fix that
`createOrder` refuses a part with no process steps.

## What landed

### 1. Pre-step — the §5.6 belt's omission half (`efac8c2`, agent 1, verified by me)

`completeSections(contract, sections)` in `erp/src/lib/template-contracts/types.ts` — **exported
from the contracts module, client-safe, exactly as the brief asked, so Tasks 9–14 copy the helper
rather than the pattern.** A leading-run merge: the config's entries lead untouched in config
order; every contract section (and every contract field inside a present section) missing from the
config appends after them in contract order with `defaultSectionConfig`/`defaultFieldConfig`.
Unknown keys pass through untouched — they stay the validator's refusal.

The design point worth carrying into Tasks 9–14: this deliberately **appends** rather than doing
the §5.3 backfill's position splice. The belt's one job is presence; it must never reorder what a
config actually says, and where an omitted element lands in a config that could never have been
stored is unspecified. The traveler builder resolves its views over `completeSections(...)` instead
of `config.sections` raw — the two-line adoption every later builder repeats.

Covered by five contract-module tests (identity on a complete config, locked-section omission,
field omission inside a present section, multiple omissions in contract order with no rewrite of
the config's own entries, unknown-key passthrough) plus three builder tests (a raw config omitting
the steps section still renders steps; omitting a locked field entry still renders it; omitting the
header section still renders barcode + order number).

### 2. `overflowTopMargin` — the two-pass render (`50e09dc`, agent 1, verified by me)

`ContinuationHeaderSpec` gained an optional `overflowTopMargin`. The header draws in the page's top
margin and pdfmake margins are per-document, so a header taller than the definition's own top
margin (the traveler's band: text + a 44pt barcode against a 24pt margin) would overlap the body on
pages 2+, while widening the margin unconditionally would move page one of **every** print — the
golden-compat killer. With the reserve set, `renderPdf` renders pass one with the original margins
and a probe header callback that captures pdfmake's own page total: one page → those bytes ARE the
result (the golden path still costs exactly one render); more → pass two re-renders with the header
active and the top margin raised to `Math.max(own, reserve)`. The probe renders a JSON deep clone
(pdfmake decorates content nodes during layout), and a function-valued definition key is refused by
name because the clone would silently drop it.

### 3. The decoder's ligature bug (`eb718ac`, mine)

`erp/tests/helpers/pdf.ts`. pdfkit maps a **ligature** glyph to MULTIPLE code points — `fl` →
`<0066 006c>` — and inside a bfrange array they arrive space-separated. `parseCmap`'s hex pattern
stopped at the space, so that entry matched nothing at all and **every later glyph id in the array
decoded one position low**: a whole page came out as a consistent substitution cipher ("the" →
"lfe"). Nothing about it was traveler-specific — any fixture text containing fi/fl/ff silently
corrupted every content assertion in that document, and it has been latent since the decoder was
written in Task 6. Task 8's overflow fixture ("**Overfl**ow Co") is what exposed it.

Fix: the hex classes admit whitespace, `hexToUtf16` strips it, and a sequential bfrange treats
everything before the last code unit as a fixed prefix. Pinned directly by a new test in
`render-primitives.test.ts` ("Overflow office affix — the quick brown fox…" round-trips), so the
next suite that trips it gets a one-line diagnosis instead of a paragraph of garbage.

Same commit adds `paintedImageCounts` (agent 2's helper): per-page image paints — `/Name Do` whose
resource entry is an image XObject — resolving both the inline and indirect `/XObject` shapes so it
survives the pdf-lib merge. `drawnPages` answers "what does page two say"; this answers "does page
two carry the barcode".

### 4. #36 — one definition per load (`6643621`)

`erp/src/server/traveler.ts`:

- **`prepareSheets(input, config, logoDataUri)`** — the shared half: resolved views (over
  `completeSections`) and a `sheetBlocks(sheet)` closure producing one sheet's block stack. Both
  builders call it, so their per-sheet content **cannot** drift; a test pins the equality
  stack-for-stack against the singular builder.
- **`buildTravelerDefinitions(...)` → `RenderableDefinition[]`** — one per load, as pure as the
  singular (plain JSON, deterministic; tested). Each carries its own `continuationHeaderSpec`
  (order number, THAT load's number, the barcode, "(continued)") with
  `overflowTopMargin: CONTINUATION_TOP_MARGIN = 64` (the band is a 44pt barcode under a 10pt
  offset; 64 clears the body). `config.pageFooter` (default OFF) adds `pageFooterSpec` and widens
  the bottom margin to `FOOTER_BOTTOM_MARGIN = 44` (Task 6's ≥ ~28pt note; 44 is the quote's own
  value). Default path keeps `[24, 24, 24, 24]` exactly — golden compat, asserted.
- **`printTraveler`** renders `renderSheetGroups(buildTravelerDefinitions(...))`. Resolution,
  stamping and the claim are untouched (Task 7's shape).
- **The identity band ignores the visibility flags.** `order_number`/`load_number` are removable on
  the *sheet*, but the band is the barcode treatment: identity on shop paper is locked, not
  configurable — a page torn loose on the floor still names its work. Label overrides still carry
  through. Both halves tested (hidden flags → band intact, sheet body honours the hide).
- **`buildTravelerDefinition` (singular) stays** as the legacy whole-document view and as the
  golden **oracle**: the "non-overflowing single-load print is content-identical to the pre-Task-8
  render" test renders it directly and compares decoded text. It is no longer called from `src/`
  — a deliberate keep, not an oversight (flagged here for the reviewer to rule on).

### 5. #43 — the all-loads bound (`8538cab`)

`MAX_TRAVELER_LOADS_PER_PRINT = 100`, a constant beside the print path with the owner ruling named
in its doc comment — **not** a setting: it bounds one request's memory and the time the order row
spends claimed, which is a property of the print path, not a business preference someone should be
able to raise to 5,000 from a settings page. (`MAX_LOADS` in `src/lib/load-split.ts` caps an ORDER
at 10,000 loads; this is the far smaller cap on what one print may render at once.)

Enforced in `readTravelerData` at the single point where "every load" is decided, so the print path
and the standalone/preview path (`collectTravelerData`) refuse identically, with a 400 naming the
count, the bound and the remedy: *"This order has 101 loads — more than the 100 an all-loads
traveler prints at once. Print the loads one at a time."* A single-load print (`?load=N`) is never
subject to it — that IS the remedy the message names.

Because the refusal precedes any definition being built, `printTraveler`'s claim can never span an
unbounded render: at or under the bound it spans at most 100 per-load documents, each page-bounded
by its own sheet. Said so in a comment at the render site, per the brief.

## RED evidence

**The decoder fix** — the inherited WIP's own overflow test, run before any change of mine
(`npx vitest run tests/traveler-templates.test.ts …`):

```
× printTraveler — sheet groups through the real path (#36) > a 20+-step recipe overflows one
  load's sheet and the continuation page carries order number, load number and barcode
  → expected 'tEOd#xxCxG#txM#n1OtsPQehgrwpeler bwxd…' to contain 'Order Number 1000'
 Test Files  1 failed | 3 passed (4)
      Tests  1 failed | 193 passed (194)
```

and the new decoder test, run against the pre-fix `parseCmap` (hex classes reverted in place):

```
× the ToUnicode decoder — LIGATURES > decodes text whose glyphs are ligatures, and everything after
  Expected: "Overflow office affix — the quick brown fox jumps over the lazy dog"
  Received: "Overow cwaxec—atchcquecikbxncfrw jcmwtcpkslzcwvercquecy—dgc..."
```

**#43** — the four boundary tests run against the same tree with the constant raised to `100_000`
(i.e. the bound absent), all else identical:

```
 Test Files  1 failed (1)
      Tests  2 failed | 2 passed | 43 skipped (47)
```

The two failures are exactly the two refusal tests (`printTraveler` returned a 101-page PDF instead
of throwing; `collectTravelerData` returned 101 sheets). The two that passed are the ones that must
pass either way — the 100-load print and the single-load remedy — which is the control this
evidence needs.

**#36** — the WIP's nine tests were written test-first by agent 2 against a builder that did not
exist; I re-verified their non-vacuity by construction (each fails to compile or to find its
assertion target without `buildTravelerDefinitions`), and the one test I added (the band ignores
visibility flags) was written against the already-written behavior — noted as such rather than
claimed as RED.

## Test inventory (all green)

`tests/traveler-templates.test.ts` (**+17, 48 total** — 3 from `efac8c2`, 9 from the WIP, 5 mine): the three omission-belt builder shapes;
`buildTravelerDefinitions` — one definition per sheet content-identical to the singular's stacks,
per-load identity band (never a following load's number on the wrong band), null-load sheet omits
the load line + label overrides carry through, band ignores the visibility flags, the `pageFooter`
knob's spec + bottom margin with the default staying off, purity/determinism; through the real
path — the 25-step overflow's continuation page carries order number + load number + a painted
barcode, per-group footer restart ("Page 1 of 1" twice on a two-load print, never "of 2"), the
default multi-load merge with today's content (no band, no footer, one barcode per page), and the
single-load print content-identical to the pre-Task-8 render; #43 — prints AT 100 (100 pages),
refuses at 101 with the exact message and archives nothing, the single-load remedy works on the
same over-bound order, and the standalone read refuses identically.

`tests/render-primitives.test.ts` (**+6, 26 total**): the five `overflowTopMargin` two-pass tests
(`50e09dc`) plus the ligature decode (mine).
`tests/template-contracts.test.ts` (**+5, 98 total**): the five `completeSections` tests (`efac8c2`).
`tests/traveler.test.ts` (28, the GOLDEN suite): **untouched and green** — the multi-load PDF is now
a merge and its content assertions still hold verbatim.

## Gate results (watched to completion, from the runs' own output, on final HEAD `8538cab`)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2411/2411, 137 files** (Task 7 baseline 2383/137 — **+28**: 17 + 6 + 5, matching the per-file counts below) | 243.4s |
| `npx tsc --noEmit` | clean | ~2s |
| `npx eslint src tests` | clean | ~10s |
| `npm run build` | exit 0 | 15.9s |
| `npm run test:e2e` | **19/19 flows PASS, exit 0** — run detached with a sentinel from the start (the Task 7 lesson), read from the run's own log | ~4.5 min |

**E2E fixture hygiene:** the harness's own teardown reported `cleanup ok`, and a direct check against the DEV database (`erp`) after the run confirms **0** rows for every fixture prefix — `Customer.code LIKE 'E2E%'` 0, `User.username LIKE 'e2e_%'` 0, `Role.name LIKE 'E2E%'` 0, `ProcessStepCode.code LIKE 'E2E%'` 0.

No `docs/HANDOFF.md`, spec-§15 or CLAUDE.md change is carried by this task: nothing here amends the contract (the spec left #43's shape to plan time; the plan's owner-ruled "refuse >100 loads" is what landed), and the phase's doc pass is plan Task 21 Step 2 — the same call Tasks 1–7 made.

## Deviations

1. **A fix outside the brief's scope: the ToUnicode decoder** (`eb718ac`). It blocked the brief's
   own required test, it is shared infrastructure every remaining conversion task decodes through,
   and leaving it would have meant either a wrong test or a fixture renamed to dodge a real bug.
   Committed separately from the feature work for exactly that reason.
2. **The #43 bound is enforced in `readTravelerData`, not in `printTraveler`.** The brief put the
   constant "beside the print path"; the check sits at the single point where "every load" is
   decided, which is on the print path AND on the standalone/preview path — so Task 19's preview
   cannot bypass it, and the refusal still precedes every render. The constant lives immediately
   above that function with the ruling named.
3. **The band renders regardless of visibility flags** (agent 2's call, which I kept and pinned with
   a test). The brief specifies the band's content unconditionally; the contract marks
   `order_number`/`load_number` removable on the sheet. Rendering identity unconditionally is the
   barcode treatment applied to the continuation page.
4. **`buildTravelerDefinition` (singular) kept** though `src/` no longer calls it — it is the golden
   oracle in the content-identity test and the whole-document view Task 19 may want. `prepareSheets`
   + the stack-equality test are what keep it from drifting.
5. The `#43` fixture creates a one-step revision because `createOrder` refuses a part without one
   (found the hard way — the first fixture had no recipe at all).

## Notes for Task 9 (ticket + MOS conversion)

- **The two-date-styles trap (carried minor, Task 1 review).** The shipping ticket prints TWO date
  styles — header `shortDate` (M/D/YYYY) vs tear-off `paddedDate` (MM/DD/YYYY) — against the
  contract's ONE date knob. Map the knob to the HEADER and leave the tear-off its own style (or give
  it its own knob), or golden compat breaks on the tear-off.
- **Copy `completeSections`, don't re-derive it.** Two lines in the builder:
  `const sectionConfigs = completeSections(X_CONTRACT, config.sections);` then resolve the views and
  iterate over `sectionConfigs` (never `config.sections`) — see `buildTravelerDefinition`.
- **The sheet-group shape is now a worked example**: `prepareSheets` (shared per-sheet content) +
  `buildXDefinitions` returning `RenderableDefinition[]` + `renderSheetGroups(...)` in the print
  path. If the ticket's tear-off ever needs per-group numbering, that is the same seam.
- `overflowTopMargin` exists now: any builder whose continuation header is taller than its own top
  margin sets the reserve instead of widening `pageMargins` (which would move page one of every
  print).
- **Decode assertions are trustworthy again** — but if a page decodes as gibberish, suspect the
  decoder before the renderer: `tests/helpers/pdf.ts`'s header comment now names the ligature class
  of bug explicitly.
- A print path that renders per group must state its own bound (or explain why it cannot exceed
  one document) — #43's comment is the precedent.

## Issues

**#36 and #43 are fixed by this task but deliberately NOT closed.** They close via the PR body's
`Fixes #36` / `Fixes #43` at merge, per the phase's convention.
