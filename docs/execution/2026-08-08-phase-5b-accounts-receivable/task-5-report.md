# Task 5 report: `src/server/ar-balances.ts` — pure A/R balance derivations

## Summary

Implemented the three pure balance derivations required by spec §4.2 and the task brief, with
integer-cent math to avoid float drift. TDD followed exactly: tests written first (RED, module not
found), implementation added (GREEN, all 5 cases pass), then the four quality gates and commit.

## Files

- Created: `erp/src/server/ar-balances.ts`
- Created: `erp/tests/ar-balances.test.ts`

## Function implementations

```ts
// Pure module — no Prisma, no I/O. The single place invoice open balance, payment on-account,
// and credit remaining are computed (spec §4.2). A balance is NEVER cached on Invoice/Payment/
// Credit; every caller (receipts, applications, aging, statements) derives it here from the live
// Application rows it already has, so there is exactly one definition of "how much is left."
import type { ApplicationTypeValue } from "@/lib/ar-constants";

export type ApplicationLite = { amount: number; type: ApplicationTypeValue; deletedAt: Date | null };

/** Dollars -> integer cents. All sums below run in cents and convert back once at the end, so
 *  e.g. `invoiceOpenBalance(0.3, [live(0.1, "PAYMENT")])` returns exactly 0.2 instead of drifting
 *  on binary-float subtraction (0.3 - 0.1 !== 0.2 in IEEE 754). */
const cents = (n: number): number => Math.round(n * 100);

const isLive = (app: ApplicationLite): boolean => app.deletedAt === null;

const sumCents = (apps: ApplicationLite[], predicate: (app: ApplicationLite) => boolean): number =>
  apps.filter((app) => isLive(app) && predicate(app))
    .reduce((sum, app) => sum + cents(app.amount), 0);

/** Invoice open balance = total − Σ live applications against it, of EVERY type — PAYMENT,
 *  DISCOUNT, WRITE_OFF, and CREDIT all reduce what the invoice still owes. */
export function invoiceOpenBalance(total: number, apps: ApplicationLite[]): number {
  return (cents(total) - sumCents(apps, () => true)) / 100;
}

/** Payment on-account = amount − Σ live PAYMENT-type applications sourced from it. Discounts and
 *  write-offs reduce the INVOICE, not the payment's remaining cash, so only PAYMENT counts here. */
export function paymentOnAccount(amount: number, apps: ApplicationLite[]): number {
  return (cents(amount) - sumCents(apps, (app) => app.type === "PAYMENT")) / 100;
}

/** Credit remaining = |total| − Σ live applications sourced from it. A credit's total is stored
 *  negative (it reverses an invoice); the remaining balance is expressed as a positive amount. */
export function creditRemaining(total: number, apps: ApplicationLite[]): number {
  return (Math.abs(cents(total)) - sumCents(apps, () => true)) / 100;
}
```

Shared helpers `cents`, `isLive`, and `sumCents` are private (not exported); `sumCents` takes a
predicate so all three public functions reuse the same filter-live + integer-cent-sum path instead
of each reimplementing it.

## TDD — RED then GREEN

**Step 1/2 — tests written, run FOREGROUND, expected FAIL (module not found):**

```
$ npx vitest run tests/ar-balances.test.ts
 FAIL  tests/ar-balances.test.ts [ tests/ar-balances.test.ts ]
Error: Cannot find module '@/server/ar-balances' imported from
'/home/cjones/Desktop/HeatSynQ/erp/tests/ar-balances.test.ts'.
...
 Test Files  1 failed (1)
      Tests  no tests
```

Confirmed RED for the right reason (module doesn't exist yet), not a typo in the test.

**Step 3 — implemented `src/server/ar-balances.ts`.**

**Step 4 — run FOREGROUND, expected PASS (all five):**

```
$ npx vitest run tests/ar-balances.test.ts
 ✓ tests/ar-balances.test.ts (5 tests) 2ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

All five brief cases passed on first implementation attempt:
1. open balance subtracts every live application type (1000 − 300 − 50 − 20 − 100 = 530)
2. open balance ignores voided applications (deletedAt set → 1000 unchanged)
3. on-account counts only live PAYMENT applications (500 − 300 = 200, DISCOUNT ignored)
4. credit remaining uses the credit's absolute total (|−937.44| − 100 = 837.44)
5. rounds in cents — no float drift (0.3 − 0.1 = 0.2 exactly, not 0.19999999999999998)

No extra edge-case tests were added beyond the brief's five — they already cover every branch
(all-types sum, void exclusion, type-filtered sum, absolute value, and cent rounding), and the
function surface is small enough that additional cases would be restating the same four branches
with different numbers rather than covering new behavior.

## Gate results (all FOREGROUND)

| Gate | Result |
|---|---|
| `npm test` | PASS — 110 test files, 1718 tests (includes the new 5) |
| `npx tsc --noEmit` | PASS — no output, no errors |
| `npx eslint src tests` | PASS — no output, no errors |
| `npm run build` | PASS — production build completed, all routes compiled |

`npm test` ran past the harness's 120s default and was moved to a background shell by the tool
itself; its output was still captured in full and inspected before treating it as a pass (110/110
files, 1718/1718 tests, exit code 0) — no gate was skipped or assumed.

## Self-review

- **Purity**: `ar-balances.ts` has exactly one import, `import type { ApplicationTypeValue } from
  "@/lib/ar-constants"` — a type-only import of a constant already documented as "no server-only
  imports." No `Prisma`, no `@/server/db`, no async, no I/O of any kind. Confirmed by reading the
  file back in full above.
- **Cents helper actually used**: `cents()` is called in all three exported functions and inside
  `sumCents`'s reduce step; every arithmetic path goes through it before the final `/ 100`, which
  is what makes case 5 (0.3 − 0.1 = 0.2) pass.
- **Names match behavior**: `invoiceOpenBalance` sums every type; `paymentOnAccount` filters to
  `type === "PAYMENT"`; `creditRemaining` takes `Math.abs` of the total. Each docstring states the
  formula from the brief verbatim, and the implementation is a direct transliteration of it.
- **Voided-drops-out**: `isLive` (`deletedAt === null`) gates every sum via `sumCents`'s filter, so
  there is exactly one place a caller could forget to exclude a voided application — and it can't,
  because the check happens on the library side, not at each call site.

## Concerns

None. The module is small, has no dependencies to drift out of sync with, and the five brief cases
plus the gate suite all passed without needing a second implementation attempt.
