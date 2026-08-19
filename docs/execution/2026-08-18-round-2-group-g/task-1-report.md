# Task 1 report — record the #103 evolution warning; correct the #102 stale comment

Implementer report, 2026-08-18. Branch `group-g-documents`, commit `954c5a1`. Prose/comments only —
the diff contains zero executable-code changes (all three `.ts` hunks are inside comment blocks;
the CLAUDE.md hunk is documentation).

## What changed, where

1. **`erp/src/lib/template-contracts/types.ts:25-39`** — new paragraph directly extending the
   "THE §5.3 BACKFILL" header paragraph, opening "THE BACKFILL ONLY COVERS GROWTH, so contracts
   evolve additively (#103)". States all three brief-required parts: (a) additive loosening is
   safe (new knob/field/section, widened enum, raised budget, removable false→true), pinned by the
   synthetic contract-growth cases in `tests/template-contracts.test.ts`; (b) tightening is not
   (new lock / removable→false, removed or renamed field key, narrowed enum, lowered
   `tableBudget`) — immutable PUBLISHED configs are re-validated at print-time dereference
   (`template-assignments.ts` `dereference` → `validateConfig`) with no catch on the print path,
   refusing "along the two-kinds split above" (`TemplateConfigError` → 500 for rule tightenings,
   `ZodError` → 400 for shape tightenings) — a reference to the existing two-kinds-of-refusal
   paragraph, not a duplication of it; (c) the two sanctioned shapes if a tightening is ever
   genuinely required (validate against the contract version PUBLISHED under, or graceful
   print-time degrade: log + contract defaults for the offending elements). Line width kept to
   the header's 98-column convention.
2. **`erp/src/lib/template-contracts/types.ts:542-543`** — one pointing sentence appended to
   `validateContractConfig`'s docblock: the battery runs at print time against immutable
   PUBLISHED configs; before tightening any rule it enforces, read the header's evolution
   warning (#103).
3. **`CLAUDE.md:102`** — the "§5.3 default backfill" sentence inside the document-templates
   paragraph now reads "…so an old version keeps rendering identically, **which is why contracts
   evolve additively only**: tightening a rule (a new lock, a removed key, a narrowed enum, a
   lowered budget) breaks print for immutable published configs — read the
   `template-contracts/types.ts` header (#103) first." Folded into the existing sentence
   (displacement, not a new block); roughly one sentence of growth, rest of the paragraph
   untouched.
4. **`erp/tests/statement-templates.test.ts:342-344`** — the stale comment stating the #102
   blank-page bug as fact ("~40, ~61 … spurious blank trailing page") replaced with the verified
   truth: this fixture's boundary counts are 77/78 and 122–124, where the raised margin
   legitimately spills the final Total Due block onto its own page (#102, closed not-reproducible
   2026-08-18); n=60 stays described as a clean mid-range fixture. Fixture and assertions
   unchanged.

## Anchors re-verified before writing

- `dereference` (`erp/src/server/template-assignments.ts:290`) calls `validateConfig` at `:308`;
  `resolveTemplate` returns through it at `:250`.
- The synthetic contract-growth cases are `erp/tests/template-contracts.test.ts:151` (knob) and
  `:165` (field).

## Gates (all from `erp/`)

| Gate | Result |
| --- | --- |
| `npm test` | 191 files, 3260 tests — all passed (counts unchanged) |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests` | clean |

E2E not run per the brief's ruling (comments/documentation only; no UI, function, or flow
touched).

## Judgment calls in the wording

- The header warning is a distinct paragraph within the same comment block, opening with an
  explicit tie-back ("THE BACKFILL ONLY COVERS GROWTH"), rather than lengthening the five-line
  §5.3 paragraph into one nineteen-line paragraph — matching the header's existing
  multi-paragraph structure ("fold naturally into the existing paragraph structure").
- The 400/500 mapping is stated inline (the brief requires it) but attributed to "the two-kinds
  split above" so the distinction itself lives in one place.
- CLAUDE.md's fold uses "which is why contracts evolve additively only", making the warning a
  consequence of the backfill sentence it displaced into rather than a free-standing claim.

No deviations from the brief.
