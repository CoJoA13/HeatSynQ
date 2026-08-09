// Pure module — no Prisma, no I/O. The informational finance-charge computation (spec §7):
// computed at statement time, never posted, never aged, no grace/minimum/compounding. Statements
// (Task 12) call this only when a run opts in to assessing finance charges.
const cents = (n: number): number => Math.round(n * 100);

export type FinanceChargeInput = {
  pastDueBalances: { open: number; exempt: boolean }[];
  // `null` is a real, expected input — `financeChargeRateFor` (below) resolves to `null` when
  // NEITHER the customer override nor the plant default is set, and Task 12's caller
  // (statements.ts) hands that resolution straight through rather than null-coalescing at the call
  // site. `!input.rate` already treats null and 0 identically, so only the annotation was ever
  // wrong — not the guard.
  rate: number | null;
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
