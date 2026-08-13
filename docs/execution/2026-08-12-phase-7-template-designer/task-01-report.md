# Task 1 report — Contract machinery + the order-side contracts

**Implementer:** fresh subagent, 2026-08-12
**Branch:** `phase-7-template-designer`
**Commits:** `6142d33` (machinery + machinery tests), `0cae14f` (the four contracts + registry + contract tests)

## What was built

`erp/src/lib/template-contracts/` — client-safe, zero server imports (the `permission-constants.ts`
precedent; the only dependency is `zod`):

- **`types.ts`** — the machinery. `TemplateContract` (ordered sections with stable keys /
  `hideable` / `reorderable`; fields with stable keys, display name, `defaultLabel`, `removable`,
  optional `column: { table, defaultWidth }`; text blocks; the per-contract format-knob surface
  with defaults; font-role defaults; optional per-table width budgets). `TemplateConfig` (section
  visibility+order, per-field visibility/order/label/width, declared format knobs, fonts,
  textBlocks record, `logo: { placement, width } | null` — bytes live on the version row —
  `pageFooter`). `configSchema(contract)` — generated zod, `.strict()` at every level, per-key
  defaults from the contract; section/field entries dispatch by `key` to per-entry strict schemas
  inside a transform (runtime-built option lists fight `z.discriminatedUnion`'s tuple typing, and
  the dispatch names the unknown key exactly). `validateContractConfig(contract, json)` — parse +
  the §5.3 backfill (scalar knobs via zod defaults; missing section/field entries re-inserted at
  their contract position with defaults) + duplicate refusal + locked-element refusal (message
  quotes `lockReason`) + pinned-section order + per-table width totals against `CONTENT_WIDTH`
  (564) or the contract's `tableBudgets`. `TemplateConfigError` for rule violations; shape
  problems stay `ZodError` (which `handle()` already maps). `defaultConfig(contract)` derives the
  complete default — backfill and `DEFAULT_CONFIG` cannot disagree by construction.
  `lockedElements(contract)` feeds the editor's padlocks.
- **`traveler.ts`, `shipper.ts`, `mos-shipper.ts`, `bol.ts`** — the four contracts, each ending in
  `DEFAULT_CONFIG = defaultConfig(CONTRACT)`.
- **`index.ts`** — `CONTRACTS: Partial<Record<TemplateDocTypeString, TemplateContract>>` with the
  four registered; `contractFor` / `validateConfig` / `defaultConfigFor` all throw a clear
  `TemplateConfigError` naming an unregistered docType.

`erp/tests/template-contracts.test.ts` — 62 tests, written red-first per cycle (machinery against
a synthetic FIXTURE contract, then the four real contracts).

## Contract-derivation decisions per document

**Traveler** (from `buildTravelerDefinition`): seven sections in stack order — `header`
(headerBlock), `lines` (linesTable [78,\*,78,88]), `quantities` (quantityTable
[78,78,\*,88,78,88]), `process` (processRow — fields `process`/`material`/`process_id`, no column
membership: the row is label/value pairs in one hand-laid table, not a per-column knob; `process`
is ruling 4's slot, defaultLabel "Process:"), `inspections` (heading field + the inner table
[\*,55,48,48,72,\*]), `steps` (stepsTable [16,62,\*,34,30,46]), `footer` (footerBlocks' nine
handwriting labels). **Locks (spec §5.6):** the `steps` section is non-hideable AND pinned
(`reorderable: false` — the ruling's "print in a fixed place"), and `step_position` / `step_code`
/ `step_instruction` / `step_values` are individually non-removable, all quoting the §15
Step-fields ruling; `step_values` is a column-less field (typed values render inside the
instruction column) so "its typed-field rendering" is an explicit locked element. The `EQ#`/`OP`
/`Date` handwriting boxes are not typed fields and stay free. `barcode` is non-removable (spec
§8 "barcode automatic"), and the `header` section is non-hideable because it carries the barcode.
Knobs: `thousandsSeparator: true` only — no date or price ever prints, so those knobs are off the
surface (a traveler config carrying `dateFormat` is refused as an unknown key; test pins it).
Fonts Roboto 8/12/6.5 (defaultStyle / company name / sub-annotations).

**Shipper + MOS shipper** (from `buildShippingTicketDefinition`): nine sections in stack order.
`liability` is a zero-field section rendering the `shipper_liability_text` text block, whose
default is `settings.ts`'s `SHIPPER_LIABILITY_DEFAULT` **copied verbatim, not imported** (server
import forbidden; keep-in-sync-by-hand until Task 14 retires the setting). The folded container
table (three columns printed twice, widths [80,\*,62]×2) gets `tableBudgets: { containers: 282 }`
— half of 564 — so width overrides cannot overflow the real six-column table; this is why the
machinery grew per-table budgets. `dateFormat` defaults to the header's `shortDate` "M/D/YYYY";
the tear-off's zero-padded style is the builder's second slot for Task 9 to map. Party boxes are
one field each (the box is one bound blob). Fonts Roboto 8/16/5.5. MOS shipper is a **full
deliberate copy** (spec §4.1: distinct docTypes free to diverge; sharing would put one template's
paper at the mercy of the other's edits — the §5.4 per-file rule); a test pins that they start
structurally identical.

**BOL** (from `buildBolDefinition`): eight sections in stack order. The **eleven** named UDSBL
constants (`RECEIVED_TEXT` … `FIBRE_NOTE`) become text blocks (`bol_received_text` …
`bol_fibre_note`), transcription quirks preserved ("here under", "(I) … (2)", "Comerce" — tests
pin them). Rule applied: named constants → text blocks; labeled/data-bound slots → fields; small
inline form glue (parenthetical captions, "RECEIVED $", "Agent or Cashier", the ship-from line's
"at"/"From" connectives) stays builder-owned and is not enumerated. The freight table
([40,\*,62,44,42]) prints beside the 170pt sidebar with an 8pt gap → `tableBudgets: { freight:
386 }`. `dateFormat` default "MMM - DD - YYYY" (`bolDate`). Fonts Roboto 7/15/5.5.

**Shared decisions.** `DATE_FORMATS` fixed set: `M/D/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`,
`MMM D, YYYY`, `MMM - DD - YYYY` — every style a Phase 3–6 builder prints is in it, so defaults
reproduce today exactly. Font families: the plan's confirmed four (Roboto, Liberation Sans,
Liberation Serif, Roboto Mono); sizes bounded 4–72pt. `pageFooter` defaults **false** everywhere
— no Phase 3–6 paper prints one, and the DEFAULT_CONFIG must be provably invisible (golden
compatibility); which seeded templates flip it on is a conversion-task/owner decision (note for
Tasks 7–14: spec §6.1 wants Page N of M delivered — the *primitive* arrives in Task 6, the
*default* stays off here). Heading/small font-role defaults are the builder's largest heading and
fine-print sizes per document (12/6.5, 16/5.5, 15/5.5, and BOL base 7); the role→slot mapping is
each conversion task's job. Width totals count only **visible** columns of **visible** sections —
hiding a column is exactly how a template frees budget to widen another.

## Deviations from the brief

1. **`validateConfig(docType, json)` lives in `index.ts`, not `types.ts`.** The registry imports
   the contract modules, which import `types.ts` — the docType-keyed lookup cannot sit below them
   without an import cycle (the invoice-guards leaf lesson, applied before the crash). `types.ts`
   carries the contract-shaped `validateContractConfig(contract, json)`; `index.ts` re-exports
   everything, so importers see one surface.
2. **`z.discriminatedUnion` not used** for section/field entries despite being the obvious zod
   shape: the option lists are built at runtime from contract data, which fights the tuple-typed
   union API, and the transform dispatch produces better messages (the unknown key is named).
   Still zod, still `.strict()` at every level.
3. **`tableBudgets` added to the contract type** (not in the brief's type list): forced by the
   ticket's two-group container fold and the BOL's freight-beside-sidebar layout — validating
   those tables against the full 564pt would let overrides overflow the paper the check exists to
   protect.

## Gate results (watched to completion, from the runs' own output)

| Gate | Result | Timing |
|---|---|---|
| `npm test` | **2195/2195, 131 files** (baseline 2133/130 — +62 tests, +1 file, all this task's) | 213.4s |
| `npx tsc --noEmit` | clean | 1.6s |
| `npx eslint src tests` | clean | 9.0s |
| `npm run build` | exit 0 | 15.5s |
| E2E | not run — no UI/function/flow touched (pure `src/lib` + tests; nothing imports the new modules yet), per the brief | — |

## Notes for Task 2 (billing-side contracts)

- Register CERT/INVOICE/STATEMENT/QUOTE in `index.ts`'s `CONTRACTS`; the registry tests'
  `REGISTERED` list in `tests/template-contracts.test.ts` and the "exactly the four" assertion
  must be updated to eight in the same change.
- `negativeStyle`/`priceDecimals` machinery is built and synthetic-tested but unused by the four
  order-side contracts — the invoice contract is their first real declarer (credits exercise
  negatives).
- The knob surface is enforced by `.strict()`: declare a knob in `formats` and it exists on the
  config with that default; leave it out and a config carrying it is refused.
- `shipper_liability_text` is already a text block on BOTH shipper contracts (the Task 2 Step 1
  retro-check); the literal matches `settings.ts` verbatim — a drift test against the server
  module is impossible from `src/lib`, so any change to the setting's code default before Task 14
  must be mirrored by hand in `shipper.ts` AND `mos-shipper.ts`.
- Cert internal notes must simply never appear as a field (spec §5.6 — nothing to lock); Task 2's
  test walks the contract against `InvoicePdfData`/cert data types — `allFields()` in the test
  file is reusable for that.
- Zero-field sections are legal and parse fine (the shipper's `liability` section is the
  precedent) — a statement/quote standing-text section can use the same shape.
