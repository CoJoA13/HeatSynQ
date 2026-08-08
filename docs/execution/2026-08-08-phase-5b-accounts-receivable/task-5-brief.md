### Task 5: `ar-balances.ts` — the pure balance derivations

**Files:**
- Create: `src/server/ar-balances.ts`
- Test: `tests/ar-balances.test.ts`

**Interfaces:**
- Consumes: `ApplicationTypeValue` (`src/lib/ar-constants.ts`).
- Produces (pure, integer-cent math, no Prisma):
```ts
export type ApplicationLite = { amount: number; type: ApplicationTypeValue; deletedAt: Date | null };
/** Invoice open balance = total − Σ live applications against it. */
export function invoiceOpenBalance(total: number, apps: ApplicationLite[]): number;
/** Payment on-account = amount − Σ live PAYMENT-type applications sourced from it. */
export function paymentOnAccount(amount: number, apps: ApplicationLite[]): number;
/** Credit remaining = |total| − Σ live applications sourced from it. */
export function creditRemaining(total: number, apps: ApplicationLite[]): number;
```

- [ ] **Step 1: Write the failing tests** (exhaustive — the money core):
```ts
const live = (amount: number, type: ApplicationTypeValue): ApplicationLite => ({ amount, type, deletedAt: null });
it("open balance subtracts every live application type", () => {
  expect(invoiceOpenBalance(1000, [live(300, "PAYMENT"), live(50, "DISCOUNT"), live(20, "WRITE_OFF"), live(100, "CREDIT")])).toBe(530);
});
it("open balance ignores voided applications", () => {
  expect(invoiceOpenBalance(1000, [{ amount: 400, type: "PAYMENT", deletedAt: new Date() }])).toBe(1000);
});
it("on-account counts only live PAYMENT applications", () => {
  expect(paymentOnAccount(500, [live(300, "PAYMENT"), live(50, "DISCOUNT")])).toBe(200);
});
it("credit remaining uses the credit's absolute total", () => {
  expect(creditRemaining(-937.44, [live(100, "CREDIT")])).toBe(837.44);
});
it("rounds in cents — no float drift", () => {
  expect(invoiceOpenBalance(0.3, [live(0.1, "PAYMENT")])).toBe(0.2);
});
```
- [ ] **Step 2: Run — Expected: FAIL** (module not found).
- [ ] **Step 3: Implement** with a shared `cents = (n) => Math.round(n * 100)` helper and integer-cent sums, dividing by 100 once at the end.
- [ ] **Step 4: Run — Expected: PASS** (all five).
- [ ] **Step 5: Commit.**
```bash
git add src/server/ar-balances.ts tests/ar-balances.test.ts
git commit -m "feat(5b): pure A/R balance derivations (open balance, on-account, credit remaining)"
```

---

