# Task 8 brief — Traveler sheet groups: #36 continuation headers + #43 the all-loads bound

**Branch:** `phase-7-template-designer` (Tasks 1–7 APPROVED; the traveler is a config-consumer, `renderSheetGroups` exists, E2E 19/19 after the quotes stale-gate fix; suite at 2383).
**Read first:** the spec §5.8 (#36/#43 as ruled) + §6.1 (per-sheet-group rendering — each group's continuation header carries THAT load's static content; per-group page restart); the plan Task 8 (**the bound is owner-ruled: REFUSE above 100 loads**, a constant, not a setting); **Task 6's report** (the primitives' margin notes: continuation header needs top margin on pages 2+; one definition per load with per-load `continuationHeaderSpec`, shared `pageFooterSpec`) and **Task 7's report** (the conversion you build on); the ledger's carried minors — **the omission-belt fix is YOUR pre-step**; `gh issue view 36` and `gh issue view 43` (the real issue texts). Then `erp/src/server/traveler.ts` (post-Task-7 shape) and `erp/src/server/pdf/render.ts` (`renderSheetGroups`).

## Pre-step (carried from Task 7's review — fix the PATTERN before six more builders copy it)

The §5.6 builder belt covers flag-flips but not entry **omission**: a validator-bypassing config that omits the steps section entry (or a locked field entry) drops the locked element — the belt only forces entries that are present. Fix in the traveler builder: merge the config's section/field lists with the contract's key list (a leading-run merge — contract keys missing from config append in contract order with contract defaults), so omission cannot drop anything. Test the omission shape (a raw config missing the steps entry still renders steps; missing a locked field entry still renders it). This merged pattern is what Tasks 9–14 will copy — make it a small reusable helper in the builder-facing side (e.g. exported from the contracts module, client-safe) rather than traveler-local, and say so in your report.

## Deliverable

1. **#36 — per-load sheet groups.** The all-loads traveler print renders **one definition per load** and merges via `renderSheetGroups`:
   - Each load's definition carries its own `continuationHeaderSpec` — static content with the order number, THAT load's number, and the barcode image (data URI) — so a sheet overflowing LETTER repeats the right identity on continuation pages, and a following load's first page never inherits a stale header.
   - The single-load print (`?load=N`) is one group — behavior unchanged except it, too, gains the continuation header for overflow (that IS #36's ask).
   - `pageFooter` (config knob) when a template enables it: numbering restarts per load group (Task 6's primitive already guarantees it; your test proves it through the traveler path). Default stays OFF — golden compat.
   - Margin handling per Task 6's notes (continuation header top margin on pages 2+; ≥ ~28pt bottom when the footer is on).
   - **Golden compat:** content-level output for existing prints is unchanged (the multi-load PDF is now a merge — same pages, same decoded content; the existing tests' content assertions must pass untouched). The overflow regression test: a 20+-step recipe overflows one load's sheet and the continuation page carries order number + load number + barcode (decode via `tests/helpers/pdf.ts`).
2. **#43 — the bound.** The all-loads print **refuses above 100 loads** with a named 400 telling the user to print per load (the constant lives beside the print path with a comment naming the ruling; NOT a setting). At or under 100: per-load rendering proceeds (memory bounded per render). The order-row lock must never span an unbounded render — with the bound + per-load renders that holds by construction; say so in a comment. Boundary tests: 100 loads prints; 101 refuses with the message (use small/fast fixture loads — the qty/weight can be trivial; you need the row count, not realistic data; keep the test's runtime sane by keeping each load's steps minimal).
3. Issues #36 and #43 are **fixed by this task** — note in your report that they close via the PR body's `Fixes #36` / `Fixes #43` at merge (do not close them now).

## Tests (TDD; RED evidence REQUIRED)

The omission-belt pre-step (both shapes); the overflow continuation header (decoded); per-group footer restart through the traveler path (enable the knob on a two-load fixture template: "Page 1 of N" twice); golden content assertions untouched and green; the 100/101 boundary; the single-load path unchanged (content-identical for a non-overflowing load).

## Gates — E2E REQUIRED (print flow touched)

Four unit gates + full `npm run test:e2e`, **run detached with a sentinel from the start** (the Task 7 lesson — a foreground run dies with your turn's shell: use `setsid nohup bash -c '... > LOG 2>&1; echo done > SENTINEL' &`, poll the sentinel, read the result from the log). Rows from the runs' own output or PENDING. Dev-DB fixtures cleared.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-08-report.md`: the merge-helper design (Tasks 9–14 copy it), the per-load definition split, RED evidence, all five gates watched, deviations, notes for Task 9 (ticket + MOS conversion — including the ledger-carried two-date-styles trap). Final message: 5-line summary + report path. Update your ledger row.
