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
