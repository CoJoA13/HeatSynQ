# Task 11 report — `finance-charges.ts` (pure informational computation)

## Summary

Implemented the pure, informational finance-charge computation (spec §7) as a standalone module
with no Prisma/I/O dependency, following the `ar-balances.ts` pure-module shape and the
`aging.ts`/Task 5's integer-cent `cents = (n) => Math.round(n*100)` convention. Statements
(Task 12) will call `financeChargeRateFor` to resolve the rate and `financeCharge` to compute the
line, only when a run opts in to assessing finance charges.

## Files

- Created: `src/server/finance-charges.ts`
- Created: `tests/finance-charges.test.ts`

## Implementation

```ts
// Pure module — no Prisma, no I/O. The informational finance-charge computation (spec §7):
// computed at statement time, never posted, never aged, no grace/minimum/compounding. Statements
// (Task 12) call this only when a run opts in to assessing finance charges.
const cents = (n: number): number => Math.round(n * 100);

export type FinanceChargeInput = {
  pastDueBalances: { open: number; exempt: boolean }[];
  rate: number;
};

/**
 * FC = round( Σ(non-exempt, past-due open) × rate/100 ). `rate` is a monthly percent (the
 * `discountPercent` convention — `1.5` = 1.5%/month). Zero when `rate` is null/0, or nothing
 * non-exempt is past due. The caller (statements) is responsible for handing in only PAST-DUE
 * balances and the resolved rate (`financeChargeRateFor`) — exempt entries are filtered here too,
 * defensively, so a mixed list is safe to pass straight through.
 */
export function financeCharge(input: FinanceChargeInput): number {
  if (!input.rate) return 0;

  const pastDueCents = input.pastDueBalances
    .filter((b) => !b.exempt)
    .reduce((sum, b) => sum + cents(b.open), 0);
  if (pastDueCents <= 0) return 0;

  return Math.round(pastDueCents * (input.rate / 100)) / 100;
}

/** Override-else-plant: `Customer.financeChargeRate` wins if set, else `BillingConfig.financeChargeRate`,
 *  else `null` (no rate at all — `financeCharge` then returns 0). */
export function financeChargeRateFor(customerRate: number | null, plantRate: number | null): number | null {
  return customerRate ?? plantRate;
}
```

Notes on the implementation:

- **Integer-cent math**: `pastDueCents` is accumulated in integer cents (each `open` dollar amount
  passed through `cents()` before summing), matching `ar-balances.ts`/`aging.ts`. The final
  `pastDueCents * (rate/100)` multiplication and `Math.round` happen once, converting back to
  dollars with a single `/100` — avoids compounding float drift across many past-due balances.
- **Exempt filtering**: `.filter((b) => !b.exempt)` drops exempt/disputed balances before summing,
  per spec §7 ("exempt/disputed invoices drop out of pastDue") and the brief's explicit
  defensive-filtering instruction — the test passes a mixed exempt/non-exempt list straight
  through rather than pre-filtering at the call site.
- **Rate null/0 handling**: `if (!input.rate) return 0` short-circuits on both `null` and `0`
  (falsy), matching "Zero when rate is null/0" verbatim.
- **`financeChargeRateFor`** uses `??` (nullish coalescing), not `||` — a customer rate of exactly
  `0` is a valid explicit override (opt out of finance charges) and must win over the plant rate,
  not be treated as "unset."

## TDD — RED then GREEN

**Step 1/2 — RED.** Wrote `tests/finance-charges.test.ts` (8 cases: the brief's four verbatim
cases plus three defensive edges — `rate: 0`, empty `pastDueBalances`, and all-exempt — noted as
useful strengthening in the brief) before the implementation existed, ran in the foreground:

```
$ npx vitest run tests/finance-charges.test.ts
 FAIL  tests/finance-charges.test.ts [ tests/finance-charges.test.ts ]
Error: Cannot find module '@/server/finance-charges' imported from
'/home/cjones/Desktop/HeatSynQ/erp/tests/finance-charges.test.ts'.
 Test Files  1 failed (1)
      Tests  no tests
```

**Step 3 — implement.** Wrote `src/server/finance-charges.ts` as shown above.

**Step 4 — GREEN.**

```
$ npx vitest run tests/finance-charges.test.ts
 ✓ tests/finance-charges.test.ts (8 tests) 2ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

All 8 cases pass, including the brief's exact values: `financeCharge({ pastDueBalances:
[{open:1000,exempt:false},{open:500,exempt:true}], rate: 1.5 })` → `15`; rate `null` → `0`;
`financeChargeRateFor(2, 1.5)` → `2`; `financeChargeRateFor(null, 1.5)` → `1.5`;
`financeChargeRateFor(null, null)` → `null`.

## Gates (foreground)

| Gate | Command | Result |
|---|---|---|
| Unit/integration | `npm test` | **PASS** — 118 test files, 1812 tests, 0 failures. `tests/finance-charges.test.ts` (8 tests) included. Ran ~178s; the harness auto-backgrounded it past the 120s default tool timeout, so its completion was awaited via the background-task notification rather than by polling — no gate ran unobserved. |
| Typecheck | `npx tsc --noEmit` | **PASS** — no output, exit clean. |
| Lint | `npx eslint src tests` | **PASS** — no output, exit clean. |
| Build | `npm run build` | **PASS** — Next.js 16.2.12 Turbopack build compiled successfully, TypeScript pass finished, all 60 routes generated. |

`npm run test:e2e` was **not** run. Rationale: this task adds a new, standalone pure module with
no Prisma/I/O and no caller yet — nothing in the app (route, page, or existing service) imports or
invokes `finance-charges.ts`. It doesn't touch any UI, existing function, or existing flow, even
incidentally (grepped `financeCharge`/`finance-charges` across `src/` and `app/`: only
pre-existing `financeChargeRate` field plumbing in `billing-config.ts`, `customers.ts`, and the two
admin/customer pages — none of which changed). Task 12 (statements) is where this module gets
wired in and where an E2E run will be warranted.

## Self-review

- **Pure — no Prisma, no I/O.** Confirmed: no imports beyond nothing (only the local `cents`
  helper); no `src/server/db`, no Prisma types, no `async`.
- **Cents helper used.** `cents()` is applied to every `open` balance before summing; the rate
  multiplication and rounding happen once on the accumulated integer-cent total, then converted
  back to dollars with one `/100` — matches the Task 5 shape referenced in the brief and the
  `ar-balances.ts`/`aging.ts` precedent files I read for style.
- **Exempt filtered.** `.filter((b) => !b.exempt)` runs before the sum; verified by the
  `{open:500,exempt:true}` case (excluded — result is `15.00`, not `22.50`) and the new
  all-exempt-→-0 case.
- **Override-else-plant correct.** `financeChargeRateFor` uses `??`, verified `financeChargeRateFor(2,
  1.5) === 2`, `financeChargeRateFor(null, 1.5) === 1.5`, `financeChargeRateFor(null, null) ===
  null`. Did not special-case `financeChargeRateFor(0, 1.5)` in a test — `??` treats `0` as a set
  override per the code's own comment; this matches the spec's "override" framing (an explicit
  zero *is* an override — the customer opted out) but wasn't in the brief's verbatim list, so I
  left it as an implementation note rather than adding a same-named test case for it.
- **Names match behavior.** `financeCharge` returns the informational amount (not a rate);
  `financeChargeRateFor` returns the *resolved rate* (not the charge) — no ambiguity between the
  two exported names, matching the brief's declared signatures exactly (same parameter names,
  same return types).

## Concerns

None blocking. Two things worth a note for Task 12 (not a defect in Task 11):

1. `financeChargeRateFor(0, plantRate)` returns `0` (a customer explicitly zeroed out), which then
   makes `financeCharge` short-circuit to `0` via the `!input.rate` check — this is almost
   certainly the intended "opt this customer out of finance charges" behavior, but it's inferred
   from the `??` choice, not spelled out verbatim in the brief's four test cases. Flagging so
   Task 12 doesn't second-guess it if it notices a `0` rate behaving like "no rate."
2. `financeCharge` does not validate that `input.pastDueBalances[].open` is itself already
   past-due or non-negative — per the brief, that filtering is the caller's (Task 12's)
   responsibility ("the caller is responsible for passing only PAST-DUE, non-exempt-decided
   balances"). This module trusts its input's `open` field, filters only on `exempt`, and treats
   `rate` as already resolved (via `financeChargeRateFor`) — as designed.
