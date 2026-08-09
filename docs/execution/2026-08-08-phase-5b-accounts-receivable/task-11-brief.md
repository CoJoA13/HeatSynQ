### Task 11: `finance-charges.ts` — the informational computation

**Files:**
- Create: `src/server/finance-charges.ts`
- Test: `tests/finance-charges.test.ts`

**Interfaces:**
- Produces (pure):
```ts
export type FinanceChargeInput = { pastDueBalances: { open: number; exempt: boolean }[]; rate: number };
/** FC = round( Σ(non-exempt, past-due open) × rate/100 ). rate is a monthly percent. Zero when rate
 *  is null/0 or nothing is past due. */
export function financeCharge(input: FinanceChargeInput): number;
export function financeChargeRateFor(customerRate: number | null, plantRate: number | null): number | null;
```

- [ ] **Step 1: Failing tests.** `financeCharge({ pastDueBalances: [{open:1000,exempt:false},{open:500,exempt:true}], rate: 1.5 })` → `15.00` (only the non-exempt 1000 × 1.5%). Rate `null` → `0`. `financeChargeRateFor(2, 1.5)` → `2` (override wins); `financeChargeRateFor(null, 1.5)` → `1.5`; `financeChargeRateFor(null, null)` → `null`.
- [ ] **Step 2: Run — Expected: FAIL.**
- [ ] **Step 3: Implement** — integer-cent, exempt filtered, override-else-plant.
- [ ] **Step 4: Run — Expected: PASS. Commit.**
```bash
git add src/server/finance-charges.ts tests/finance-charges.test.ts
git commit -m "feat(5b): pure informational finance-charge computation with per-customer rate override"
```

---

