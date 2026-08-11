# Task 3 report: `gl-mapping.ts` — the pure journal + readiness engine

## Summary

Implemented exactly per `task-3-brief.md`, verbatim code and test code, no deviations. Two new
files (`erp/src/lib/gl-constants.ts`, `erp/src/server/gl-mapping.ts`) plus the test
(`erp/tests/gl-mapping.test.ts`). Standalone task — no dependency on Tasks 1/2's code, and nothing
in Tasks 1/2 depends on this yet (Task 6, `gl-export.ts`, is the consumer).

## TDD evidence

**RED** (Step 3, before implementation):

```
FAIL  tests/gl-mapping.test.ts [ tests/gl-mapping.test.ts ]
Error: Cannot find module '@/server/gl-mapping' imported from
'/home/cjones/Desktop/HeatSynQ/erp/tests/gl-mapping.test.ts'.
```

**GREEN** (Step 5, after implementation):

```
✓ tests/gl-mapping.test.ts (5 tests) 2ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

All 5 brief tests pass:
1. an invoice posts DR A/R = CR revenue + tax and balances
2. a credit reverses the sales entry (DR revenue/tax, CR A/R)
3. a payment posts DR cash = CR A/R, balanced and keyed on the payment id
4. reverseLines swaps debit/credit and flags isReversal
5. readinessGaps lists a step code, surcharge, payment type, and missing A/R default

## Gates run

- `npx vitest run tests/gl-mapping.test.ts` — 5/5 pass.
- `npx tsc --noEmit` — clean, no output.
- `npx eslint src tests` — 0 errors, 1 pre-existing warning: `tests/gl-mapping.test.ts:2:88
  'CashEvent' is defined but never used (@typescript-eslint/no-unused-vars)`. This comes from the
  brief's own verbatim test import (`type SalesEvent, type CashEvent` — `CashEvent` is never
  referenced by name in the test body because the object literals passed to `cashJournal` are
  structurally inferred). Exit code 0; not a blocker, and the test code was used exactly as
  specified, per the brief's "use verbatim" instruction. Not fixed by editing the test, since doing
  so would deviate from the brief.
- `npm test` (full suite, real `erp_test` DB) — 122 files / 1889 tests, all pass. Confirms no
  regression anywhere else in the repo.
- `npm run test:e2e` — skipped per task instructions (no UI/flow touched).

## Self-review

- **Purity confirmed.** `grep -n "^import"` on both new files shows exactly one import:
  `import type { JournalSide, PostingSourceType } from "@/lib/gl-constants";` in `gl-mapping.ts` —
  type-only, no Prisma, no service imports, no I/O. `gl-constants.ts` has no imports at all.
  `gl-mapping.ts` is a true leaf, safe for `gl-export.ts` (Task 6) to build on.
- **Balance property.** Every emitted line pair/set nets to zero by construction:
  - `salesJournal` — one A/R line (debit for INVOICE, credit for CREDIT) offset by the revenue
    lines + optional tax line on the opposite side, all using the *same* signed amounts, so
    Σdebit − Σcredit telescopes to zero regardless of the revenue split. Verified algebraically and
    by the two salesJournal tests (108 = 100 + 8, and 50 = 50).
  - `cashJournal` — always exactly a 2-line self-balancing pair (debit the cash/discount/write-off
    account, credit A/R) for the *same* amount, both lines keyed on the event's own `sourceId` (not
    an aggregate). Verified by the payment test (`sourceId` "pay1" on both lines) and the discount
    case feeding `reverseLines`.
  - `reverseLines` swaps debit/credit per line, which preserves the balance invariant trivially
    (swapping both sides of a balanced set keeps it balanced) and sets `isReversal: true`.
  - Money is compared in integer cents throughout the test's `sum()` helper
    (`Math.round(x * 100)`), matching the "money in integer cents" constraint; the internal `c()`
    helper in `gl-mapping.ts` uses the same rounding to decide whether a revenue/tax line is
    zero-and-droppable.
- **`isReversal` discipline.** All four mapper-produced lines in `salesJournal`/`cashJournal` set
  `isReversal: false` explicitly (never omitted/defaulted); only `reverseLines` sets it `true`. No
  path can produce a line with an implicit truthy/falsy `isReversal`.
- **No aggregate A/R line.** Confirmed `cashJournal` takes one `CashEvent` and always keys both of
  its output lines on that single event's `sourceId` — there is no code path in this module that
  merges multiple cash events into one A/R line, matching the brief's explicit "never an aggregate
  A/R" instruction.
- **Client-safety.** `gl-constants.ts` has zero imports, so it is trivially importable from client
  components (mirrors `ar-constants.ts`'s existing style, confirmed by reading that file first).
- **Diff scope.** Only the three intended files are staged/committed (`git status` before commit
  showed no other tracked-file changes pulled in; a `.superpowers/sdd/.gitignore` change and two
  untracked docs files from earlier session activity were correctly left untouched).

## Commit

`52af93a` — `feat(5c): pure GL mapping engine (sales/cash journals + readiness gaps)`
(no attribution trailer, per repo convention). 3 files changed, 180 insertions.

## Concerns for the reviewer

- The one eslint warning (unused `CashEvent` type import in the test) is inherent to the brief's
  verbatim test code and does not fail the gate (0 errors, exit 0). Flagging it rather than
  silently "fixing" it by editing the brief's specified test.

## Fix round 1 (2026-08-09)

Reviewer found one Important (correctness/data-integrity) and two Minor findings. All three fixed.

**Important — missing sales-tax readiness check.** `readinessGaps` never checked for a missing
sales-tax GL account, but `salesJournal` silently drops the tax credit line when `taxGlAccountId`
is null while the A/R debit (`ev.total`) still includes tax — so a taxable invoice with no tax
account configured would pass readiness yet produce an unbalanced journal on export. Fixed by
extending the readiness contract:

- `ReadinessInput` gained two fields: `salesTaxGlAccountId: string | null` and `hasTax: boolean`
  (any in-scope invoice with `taxTotal != 0` — its A/R debit already includes the tax).
- `readinessGaps` now pushes a `plant-default` gap ("Sales tax account is not set",
  `/admin/billing`) when `hasTax && !salesTaxGlAccountId`, right after the write-off check.
- Existing test `"readinessGaps lists a step code, surcharge, payment type, and missing A/R
  default"` updated to pass `salesTaxGlAccountId: "t", hasTax: false` so it keeps compiling and
  keeps its original assertion (no new gap kind introduced for that case).
- New test `"flags a missing sales-tax account when a taxable event is in the delta"` — asserts
  exactly one gap, label matching `/sales tax/i`.

**Minor — unused import.** Dropped `type CashEvent` from `tests/gl-mapping.test.ts`'s import (the
cash tests use inline object literals, so it was never referenced by name); this was the sole
eslint warning noted in the original report and is now gone.

**Minor — needless template literals.** The three static `readinessGaps` href strings
(`/admin/step-codes`, `/admin/surcharges`, `/admin/reference`) had no interpolation; switched from
backtick template literals to plain double-quoted strings.

### Commands run

```
npx vitest run tests/gl-mapping.test.ts
```
```
 ✓ tests/gl-mapping.test.ts (6 tests) 4ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

```
npx eslint src/server/gl-mapping.ts src/lib/gl-constants.ts tests/gl-mapping.test.ts
```
```
(no output — 0 errors, 0 warnings)
```

```
npx tsc --noEmit
```
```
(no output — clean)
```

### Commit

`6b6d13c` — `fix(5c): readiness flags a missing sales-tax account; pristine lint`
(no attribution trailer, per repo convention). 2 files changed (`src/server/gl-mapping.ts`,
`tests/gl-mapping.test.ts`), 21 insertions, 6 deletions. Diff scope verified via `git status`
before committing — only the two intended files staged; unrelated pre-existing working-tree
changes (`.superpowers/sdd/.gitignore`, roadmap/spec docs from earlier session activity) were
left untouched, consistent with the original task's diff-scope discipline.
