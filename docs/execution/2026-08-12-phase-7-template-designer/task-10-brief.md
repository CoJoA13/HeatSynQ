# Task 10 brief — BOL conversion

**Branch:** `phase-7-template-designer` (Tasks 1–9 APPROVED; the ticket conversion is the freshest pattern; suite at 2449; E2E 19/19).
**Read first:** the spec §5.4/§5.6 + plan Task 10; **Task 9's report** (its Task 10 notes are the map: copy the resolution+stamp block from `printShippingTickets` minus the docType ternary — the BOL is one-per-shipment, docType `BOL` regardless of order count; use the liability-through-data seam for the UDSBL text; `renderPdf` on one `RenderableDefinition` suffices — single-document paper; `textRunsWithY` exists for position assertions). Then `erp/src/server/pdf/bol.ts` in full, `printBol` in `erp/src/server/shippers.ts` (~:1994–2060), and the BOL contract.

## Pre-step (carried from Task 9's review)

`erp/src/server/shippers.ts` ~:1891 — the comment says "Counted under the claims," but `shipmentOrderIds` reads *before* the lock statements; the real guarantee is the Serializable snapshot fixed at the stub read keeping the count and the rendered data mutually consistent. Fix the comment to name the actual mechanism (behavior is correct; no code change).

## Deliverable

1. **`buildBolDefinition(data, config)`** — config-consumer per the established pattern (`completeSections`, §5.6 both halves, sections/fields/labels/widths/fonts/formats): the **eleven UDSBL legal text constants render from the config's text blocks** (seeded with today's literals — Task 3's seed already carries them; delete the in-file constants once the config drives them, golden holding); the single `bolDate` style maps directly from the date knob (ONE style on this paper — no trap, but verify by grepping the builder for every date call before assuming; say so in the report). The COLLECT "X", freight table, and sidebar render per config where the contract declares them.
2. **`printBol`** — after the existing claims, inside the Serializable transaction: `resolveTemplateForPrint(tx, "BOL", shipper.customerId)`; logo per the pattern; `storeDocument(..., templateVersionId: resolved.versionId)` (the BOL's is the store at ~`shippers.ts:2054`); the **lazy BOL-number allocation stays byte-identically untouched** — the number allocates on first print exactly as today.
3. **Page N of M** via the `pageFooter` knob (default OFF — golden); a `continuationHeaderSpec` is NOT needed unless the paper can overflow — check whether any live BOL data path can exceed one page (many order lines?); if it can, give it the identity header per the ticket pattern; if it provably cannot, say so in the report instead of adding dead code.

## Tests (TDD; RED evidence REQUIRED)

Golden: `tests/bol.test.ts` untouched, green. Config-driven: label/width/font/format overrides; the legal text from config both directions (edited text block reaches paper; the in-file constants gone); §5.6 omission + flag; resolution + stamp through the real print path with a marker template + assignment (single- AND multi-order shipments both resolve `BOL` — one test proving the docType is count-independent); footer restart n/a (single group) but the knob-on prints "Page 1 of N"; lazy number allocation regression (first print allocates, reprint reuses — the existing tests likely cover it; keep them green).

## Gates — E2E REQUIRED

Four unit gates + full E2E **detached from the start with a PER-TASK sentinel name** (`e2e-task10.done` — Task 9's stale-sentinel process note is now the rule: never reuse a sentinel filename across tasks). Rows from the run's own output or PENDING. Dev-DB fixtures cleared.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-10-report.md`: the overflow-or-not finding, the date-style grep result, RED evidence, all five gates watched, deviations, notes for Task 11 (cert). Final message: 5-line summary + report path. Update your ledger row.
