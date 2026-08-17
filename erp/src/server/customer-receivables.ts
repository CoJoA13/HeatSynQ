/**
 * The customer page's A/R section (Task 15, P5B §11): the customer's own net balance/aging
 * buckets plus its own open items — composed from Task 10's `aging.ts` and Task 13's
 * `applications.ts`, no balance math of its own (CLAUDE.md: reuse `ar-balances`/`aging`/
 * `applications`, never re-derive). A dependency-light leaf, the `invoice-guards.ts` precedent:
 * `aging.ts` and `applications.ts` do not import each other, and this file composes both without
 * either module needing to know about the other.
 *
 * Fix round 1 (Task 15 review, Important): the FIRST version of this function paired
 * `agingReport({ customerId })` with `openInvoicesForPayer(customerId)` and assumed the two agreed
 * on scope. They do not, for a DIVISION (a customer with a `parentId`): `agingReport` returns only
 * that one customer's own row unless it is itself a PARENT (never a child), while
 * `openInvoicesForPayer` resolves `rootId = parentId ?? id` and returns the whole FAMILY's open
 * invoices — parent plus every sibling — because a payment can legitimately settle across
 * divisions (that function's own header comment). Composed together, a division's page showed a
 * net balance scoped to that division alone above an open-items table that actually listed
 * unrelated siblings' invoices, unlabeled and not reconciling with the net.
 *
 * This section is framed around ONE customer, so both figures now read that ONE customer's OWN
 * A/R — never a family roll-up, whether the customer is a parent, a child, or standalone:
 * `customerOwnAgingRow` (aging.ts) and `openInvoicesForCustomer` (applications.ts), the
 * single-customer siblings added alongside `agingReport`/`openInvoicesForPayer` specifically so
 * those two functions' existing family-resolving behavior — which Tasks 10/13's callers rely on —
 * stays untouched.
 */
import { Prisma } from "../../prisma/generated/prisma/client";
import { todayDateOnly, formatDateOnly } from "../lib/business-days";
import { prisma } from "./db";
import { customerOwnAgingRow, type AgingRow } from "./aging";
import { openItemsForCustomer, type CustomerOpenItem } from "./applications";

export type CustomerReceivablesSummary = { aging: AgingRow; openItems: CustomerOpenItem[] };

/**
 * Both reads are scoped to the SAME single customer id — never a family — so the open-items table
 * and the net/aging strip always describe the same set.
 *
 * Fix round 2 (#83): they now describe the same KINDS as well. The strip has always folded open
 * credits and on-account cash into `unapplied`/`net`, while the table listed finalized invoices
 * alone — so the number above it could not be arrived at from the rows in it, and a customer
 * holding nothing but a credit read a negative net over the words "No open invoices".
 * `openItemsForCustomer` composes all three kinds, credits and cash NEGATIVE, so the rows SUM to
 * the net.
 *
 * And they are read from ONE RepeatableRead snapshot (the `agingReport` precedent named in
 * CLAUDE.md's reports rule): reconciliation is the whole point of this pair, so a commit landing
 * between two autocommit reads must not be able to break it. Still a pure read — no claim, no
 * write, not Serializable.
 */
export async function customerReceivablesSummary(customerId: string): Promise<CustomerReceivablesSummary> {
  // ONE as-of, sampled once and handed to BOTH halves (review round 1). They each defaulted to
  // "today" independently, which is nearly always the same instant but is not the same VALUE — and
  // more importantly the open-items read applied no cut at all, so a post-dated receipt showed up as
  // a row the strip did not count. Same moment, same cuts, or the sum stops meaning anything.
  const asOf = todayDateOnly();
  return prisma.$transaction(async (tx) => {
    const [aging, openItems] = await Promise.all([
      customerOwnAgingRow(customerId, formatDateOnly(asOf), tx),
      openItemsForCustomer(customerId, tx, asOf),
    ]);
    return { aging, openItems };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
