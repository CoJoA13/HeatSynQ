# Task 1 brief — Contract machinery + the order-side contracts

**Branch:** `phase-7-template-designer` (you are already on it; baseline gates green at 2133 tests).
**Read first, in this order:** `CLAUDE.md` (house rules — especially "Constraints that will bite you" and "Working conventions"); the approved spec `docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md` §5.3 (the template contract), §5.6 (locked elements), §3 ruling 3 (format knobs); the plan `docs/superpowers/plans/2026-08-12-phase-7-template-designer.md` — Global Constraints + Task 1. Then the four builders you are deriving contracts from: `erp/src/server/traveler.ts` (buildTravelerDefinition + TravelerData), `erp/src/server/pdf/shipping-ticket.ts`, `erp/src/server/pdf/bol.ts`, and `erp/src/server/pdf/render.ts` (CONTENT_WIDTH context — note the builders define their own 564pt constants).

## Deliverable

`erp/src/lib/template-contracts/` — **client-safe, pure declarations + zod. NO imports from `src/server/**` anywhere in this directory** (the editor will import it from client components; this is the `permission-constants.ts` precedent).

1. **`types.ts` — the machinery:**
   - Contract types: a `TemplateContract` describing ordered **sections** (stable `key`, display name, `hideable`, `reorderable`), each section's **fields** (stable `key`, display name, default label, `removable`, optional table-column membership with a default width), **text blocks** (key + default text), **format knobs** (number formats: negative style / price decimals 2–4 / thousands separator; ONE date format from a fixed set), **font roles** (base/heading/small sizes + one family from the curated list: `Roboto`, `Liberation Sans`, `Liberation Serif`, `Roboto Mono`), and **locked elements** (keys that may never be hidden/removed).
   - `TemplateConfig` — the per-version JSON: section visibility+order, per-field visibility/order/label override, column-width overrides, format knob values, font choices, text-block values, logo placement (`header-left|header-center|header-right` + width) — logo *bytes* live on the version row, NOT in config — and `pageFooter: boolean` ("Page N of M").
   - `configSchema(contract)` — zod, `.strict()` at every level; unknown keys refused; **unknown font family refused**.
   - `validateConfig(docType, json)` — parses against the type's contract **and applies the contract's defaults for every absent key** (spec §5.3's backfill: a config stored before a knob existed must keep rendering identically — the parse result is always a complete `TemplateConfig`).
   - Validation rules: a config that hides a locked section/field is **refused with a message naming the lock's reason**; per-table column-width totals are validated against the 564pt content width (LETTER minus margins).
2. **`traveler.ts`, `shipper.ts`, `mos-shipper.ts`, `bol.ts`** — the four contracts, each ending in a `DEFAULT_CONFIG` that reproduces today's hardcoded builder values EXACTLY (labels, widths, sizes, formats, text defaults):
   - Derive sections/fields from what each builder actually prints — walk the builder code; every printed label and column becomes a field with a stable key. Do not invent fields the data layer doesn't collect (spec §5.3: a template can never add a data source).
   - **Traveler**: the steps section and its typed-field rendering, and the barcode, are LOCKED (spec §5.6; the master spec §15 Step-fields ruling is the reason string). The Process: slot is a field (binds `part.processName` — Phase 7 adds it later; the contract just declares the slot).
   - **Shipper vs MOS shipper**: one builder serves both today (`buildShippingTicketDefinition`); write two contracts (they may start structurally identical — that is expected; spec §4.1 makes them distinct docTypes free to diverge). `shipper_liability_text` is a text block on BOTH (default = the code default from `settings.ts` — copy the literal, do not import the server module).
   - **BOL**: the ~10 UDSBL legal constants in `bol.ts` become its text blocks' defaults.
3. **`index.ts`** — `CONTRACTS: Record<TemplateDocTypeString, TemplateContract>` registry (string keys for now — the Prisma enum lands in Task 3; use a local union type `"TRAVELER" | "SHIPPER" | "MOS_SHIPPER" | "BOL" | "CERT" | "INVOICE" | "STATEMENT" | "QUOTE"`; register the four built ones, leave the other four unregistered until Task 2 — the registry type should allow partial registration cleanly or use a narrower union, your call, but `validateConfig` on an unregistered type must throw a clear error, not return undefined).

## Tests — `erp/tests/template-contracts.test.ts` (TDD: write failing first)

- Each `DEFAULT_CONFIG` validates against its own contract.
- The backfill: strip a knob from a serialized `DEFAULT_CONFIG`, re-parse, get the default back (add a synthetic-knob variant: extend a copy of a contract with a new knob and re-parse an old config).
- Locked-element refusal (hide traveler steps → refused, message names the rule); width-overflow refusal (widths summing past 564 → refused); unknown-key refusal (`.strict()`); unknown-font refusal.
- Label/format/width overrides round-trip through validate → serialize → validate.
- Purity: `JSON.parse(JSON.stringify(config))` deep-equals (the config is data; the house purity idiom).

## Conventions that WILL be checked at review

- TDD (red → green per feature); conventional commits, **no attribution trailer**.
- No server imports in `src/lib/template-contracts/`; no `Date.now()`/locale-dependent behavior in the contracts.
- Comment density/idiom matching the codebase (constraints the code can't show, nothing else).
- All four gates green at the end: `npm test`, `npx tsc --noEmit`, `npx eslint src tests`, `npm run build` (from `erp/`; DB is up). No UI/flow touched → E2E not required for this task.
- Commit `docs/execution/2026-08-12-phase-7-template-designer/` (this brief + the ledger + your report) with your first commit if not already committed.

## Report

Write `docs/execution/2026-08-12-phase-7-template-designer/task-01-report.md`: what you built, the contract-derivation decisions you made per document (which builder lines became which fields), any deviation from this brief with its reason, gate results (watched, with numbers), and anything Task 2 (billing-side contracts) should know. Your final message: a 5-line summary + the report path.
