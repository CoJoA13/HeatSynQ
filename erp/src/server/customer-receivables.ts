/**
 * The customer page's A/R section (Task 15, P5B §11): the customer's own net balance/aging
 * buckets plus its open items — composed from Task 10's `agingReport` and Task 13's
 * `openInvoicesForPayer`, no balance math of its own (CLAUDE.md: reuse `ar-balances`/`aging`/
 * `openInvoicesForPayer`, never re-derive). A dependency-light leaf, the `invoice-guards.ts`
 * precedent: `aging.ts` and `applications.ts` do not import each other, and this file composes
 * both without either module needing to know about the other.
 */
import { HttpError } from "./errors";
import { agingReport, type AgingRow } from "./aging";
import { openInvoicesForPayer, type OpenInvoiceRow } from "./applications";

export type CustomerReceivablesSummary = { aging: AgingRow; openItems: OpenInvoiceRow[] };

/**
 * `agingReport({ customerId })` always returns a row whose `customerId` is the id passed in — the
 * customer's own row when it has no children, or the synthesized family-total row (still keyed on
 * the parent's own id) when it does (aging.ts's own comment on that branch) — so this section
 * always reads "this customer's" net/buckets, rolled up with its family when it is itself a family
 * head, matching the `statements.ts` "combined" default for a parent. `openInvoicesForPayer`
 * already resolves the payer's family on its own (applications.ts), so the two reads agree on
 * scope without either one telling the other what it did.
 */
export async function customerReceivablesSummary(customerId: string): Promise<CustomerReceivablesSummary> {
  const [rows, openItems] = await Promise.all([
    agingReport({ customerId }),
    openInvoicesForPayer(customerId),
  ]);
  const aging = rows.find((r) => r.customerId === customerId);
  // Defensive only — `agingReport` itself throws 404 before this could ever be reached with an
  // empty/mismatched result; kept so this function's own return type never needs a null case.
  if (!aging) throw new HttpError(404, "Customer not found");
  return { aging, openItems };
}
