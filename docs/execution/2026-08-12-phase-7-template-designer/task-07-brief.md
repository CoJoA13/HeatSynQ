# Task 7 brief — Traveler conversion + the stamp plumbing

**Branch:** `phase-7-template-designer` (Tasks 1–6 APPROVED; the full template infrastructure exists — contracts, data, service, resolution, render primitives; suite at 2352; E2E 19/19).
**Read first:** `CLAUDE.md` (the render section; the E2E rule); the spec `docs/superpowers/specs/2026-08-12-phase-7-template-designer-design.md` **§5.4 (builders become config-consumers) + §5.1's publish-vs-print paragraph (resolution at ANY isolation by immutability — the traveler deliberately stays at default isolation) + §5.6 (locked elements render regardless) + §5.7 (the traveler half of `processName`: binds LIVE at render, blank prints nothing) + §5.2 (resolution)**; the plan Task 7; **Task 5's report** (the resolution-consumer notes: call `resolveTemplateForPrint(tx, "TRAVELER", customerId)` inside the print's existing claimed transaction, no template claim, feed the already-backfilled config straight in) and **Task 6's report** (its Task 7 notes: `RenderableDefinition` opt-in; `pageNofM` needs ≥ ~28pt bottom margin; continuation-header top margin on pages 2+; pick `pngDataUri`/`jpegDataUri` by stored `logoMimeType`). Then `erp/src/server/traveler.ts` in full (694 lines — the file you are converting) and the traveler contract (`erp/src/lib/template-contracts/traveler.ts`).

## Scope guard

**NOT this task:** per-load sheet groups, #36 continuation headers, #43 the >100-loads bound — all Task 8. The traveler's `pageFooter` stays default-false (golden compat). This task = config consumption + resolution + the stamp plumbing every later conversion reuses.

## Deliverable

1. **Stamp plumbing** (`erp/src/server/documents.ts`): `storeDocument` gains an optional `templateVersionId` in its owner/args shape, written to the `StoredDocument` row. Tasks 8–14 just pass it. Test: a stored row carries the id; omitting it stores null (pre-Phase-7 shape untouched).
2. **`buildTravelerDefinition(data, config)`** — the second parameter is the **backfilled** `TemplateConfig` for `TRAVELER` (the builder may assume completeness — `validateConfig` guarantees it; do not re-default inside the builder):
   - **Sections**: visibility + order from config (hidden section → omitted from the stack; reordered → stack order follows config). Locked sections (steps) render REGARDLESS of config — the validator refuses such configs, but the builder must not trust that alone (spec §5.6's defense-in-depth: belt in the builder, log nothing, just render them).
   - **Fields**: visibility, order, and label overrides from config per section; the barcode always renders.
   - **Column widths**: from config where the contract declares a column (the width-budget was validated at save; the builder just applies).
   - **Fonts**: family per role from config (the render-side belt throws on unregistered — Task 6); sizes from config's roles.
   - **Formats**: date format from config (the traveler's dates); number formats where the contract declares them.
   - **Logo**: when the resolved version carries logo bytes AND config places it — the print path converts bytes → data URI (`pngDataUri`/`jpegDataUri` by `logoMimeType`) and passes it into the builder via `TravelerData` (or a third param — your call; keep the builder pure, document the choice); the header block reflows per the placement slot (`header-left`/`header-center`/`header-right` + width). No logo → today's text-only header, byte-for-byte.
   - **The Process: slot** binds `data.processName` (new `TravelerData` field; `readTravelerData` reads it live from the lead part's `processName`): blank → the slot renders exactly as today (blank). Non-blank → prints the name.
   - **Purity unchanged**: no I/O, no clock; the round-trip test extends to config-driven output.
3. **`printTraveler`** (`erp/src/server/traveler.ts`): inside the existing transaction (isolation deliberately unchanged — comment the §5.1 immutability argument at the call site), after the order claim: `resolveTemplateForPrint(tx, "TRAVELER", order.customerId)` → build with the returned config (+ logo data URI when present) → `renderPdf` → `storeDocument(..., templateVersionId: resolved.versionId)`.

## The golden-compat gate (standing from this task on)

**Every pre-existing traveler test passes UNCHANGED** — the seeded "Standard" config must reproduce today's paper exactly through the new code path. If a golden test fails, the bug is in your config mapping (or, worse, in a Task 1 `DEFAULT_CONFIG` value the earlier reviews missed — if you find such a drift, STOP, document it in the report, fix the contract value with its own RED test, and note it prominently for the ledger; the seed-vs-constant drift guard and the seeded DB rows must be re-checked — the seed migration is FROZEN, so a contract-value fix needs a new migration correcting the seeded row, not an edit to the applied one).

## Tests (TDD; RED evidence REQUIRED)

- Golden: the full existing traveler suite green, untouched.
- Config-driven: hidden section omitted; reorder respected; label override prints; width override applied; font family/size switch visible in the rendered bytes (Task 6's decoder technique — lift it into `tests/helpers/` now if you use it, WITH the `endstream` guard from the carried minor); a config hiding steps still renders steps (the builder belt).
- Logo: placed logo renders (PNG and JPEG); no-logo byte-path unchanged.
- `processName`: blank → today's output; set → prints in the slot.
- Resolution wiring: a customer-assigned template's published config prints (not the default); the stamp lands on the `StoredDocument` row; a draft on the same template does NOT affect the print (immutability, asserted through the real print path).
- `storeDocument` stamp tests (item 1).

## Gates — E2E REQUIRED (print flow touched)

All four unit gates + `npm run test:e2e` watched to the end (the detached-sentinel discipline if needed; row from the run's own output or PENDING). Dev-DB fixtures cleared.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-07-report.md`: the config-mapping decisions, the logo-passing design choice, RED evidence, all five gates watched, deviations, notes for Task 8 (sheet groups build directly on your conversion). Final message: 5-line summary + report path. Update your ledger row.
