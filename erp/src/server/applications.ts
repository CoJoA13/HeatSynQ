import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedSoftDelete } from "./audit";
import { decimalField } from "./decimal-field";
import { claimOrder, claimOrdersInOrder, sortedClaimIds } from "./order-locks";
import { invoiceOpenBalance, paymentOnAccount, creditRemaining, type ApplicationLite } from "./ar-balances";
import { assertPeriodOpen } from "./period-locks";
import { getSetting } from "./settings";
import { addDays, formatDateOnly, todayDateOnly } from "../lib/business-days";
import { invoiceDocumentNumber } from "../lib/invoice-constants";

// -------------------------------------------------------------------------------------------
// Task 7 (P5B §4.1/§4.2): the single cash write path. Every reduction of an invoice's open
// balance — a PAYMENT, an early-pay DISCOUNT, or a WRITE_OFF — is one `Application` row, and this
// is the only file that writes them (Task 8 extends it with CREDIT application). No balance is
// ever cached: `ar-balances.ts` derives every open balance / on-account from the live rows, so
// this file's only jobs are the row claims that serialize concurrent applications and the
// over-application / discount-window rules that decide whether a line may be written at all.
//
// THE CLAIM (global-constraints.md, the 5A invoice-mutation discipline). A payment can settle
// several invoices at once — across a parent's divisions, so cross-customer — so the claim is the
// multi-order shape, never a per-invoice loop:
//   1. An UNLOCKED stub read to learn each target invoice's `orderId` and validate it is a live
//      FINALIZED INVOICE (the `shippers.ts`/`claimInvoiceRow` "stub read to learn which order to
//      claim" precedent — `orderId`/`kind` never change once an invoice exists, so a bare read is
//      safe for them; the guarded state is re-read under the locks below).
//   2. `claimOrdersInOrder(tx, orderIds)` — ONE sorted statement over the deduplicated, ascending
//      order ids behind the invoices (order-locks.ts), so a payment touching orders {A,B} and one
//      touching {B,A} can never form the ABBA cycle a per-order loop would.
//   3. The invoice rows themselves, in ONE sorted `FOR UPDATE` statement mirroring
//      `claimOrdersInOrder`'s shape — claimed AFTER the order claims, uniformly (one fixed lock
//      order: orders, then invoices), so no new ABBA window opens. The guarded balance is derived
//      from `Application` rows keyed to the invoice, so the INVOICE ROW is the lock that serializes
//      applications to it — the invoice-row claim, NOT the Serializable isolation, is what makes
//      the over-application check and the write it guards see the same state.
//   4. The payment row `FOR UPDATE`, last and uniform — the payment-on-account invariant
//      (Σ live PAYMENT applications ≤ payment.amount) is keyed to `paymentId`, so two applications
//      spending the SAME payment against DIFFERENT invoices — which share no invoice or order lock
//      — serialize here instead (the house rule: the guarded state must be locked with a claimed
//      row).
// The transaction runs Serializable to pair with the FK-writer reads on the invoice/payment rows,
// exactly as every 5A/5B mutator does — but the row claims, never the isolation level, are what
// protect the invariants (never present isolation as the lock).
// -------------------------------------------------------------------------------------------

type Db = Prisma.TransactionClient;

const cents = (n: number): number => Math.round(n * 100);

/** CRITICAL (Task 5 carry): `Application.amount` is a Prisma `Decimal`; every value crossing into
 *  `ar-balances` must be `.toNumber()`'d first. */
const toLite = (a: { amount: Prisma.Decimal; type: ApplicationLite["type"]; deletedAt: Date | null }): ApplicationLite =>
  ({ amount: a.amount.toNumber(), type: a.type, deletedAt: a.deletedAt });

// -------------------------------------------------------------------------------------------
// discountAvailable — the early-pay window (§4.3). Terms carry a discount iff BOTH `discountPercent`
// and `discountDays` are set; the window is open iff the payment was received on or before
// `invoiceDate + discountDays` calendar days (`addDays`, not business days — a terms deadline is a
// calendar date, the `dueDate` precedent). The eligible amount is `discountPercent% × the invoice's
// open balance`, integer-cent half-up. Zero out of window, zero with no terms discount.
//
// THE SETTLEMENT RULE (#69, owner ruling 2026-08-19; spec §15). **A discount is earned only by a
// payment that SETTLES the invoice — a partial payment inside the window earns nothing at all.**
// This is a guard, not a basis change: the eligible figure is still `discountPercent × the open
// balance`, exactly as it always was. What is new is that it is offered (and accepted) only when
// this payment's unapplied cash can actually close the remainder net of it — `cash ≥ open − eligible`.
// Settlement is judged against what is STILL OPEN, never the original total, so a customer who
// part-paid earlier can still settle the remainder early and earn the percentage on what remains.
//
// It is enforced at BOTH read sites, which cap independently: here (the offer the apply grid renders
// as a "Take 20.00" checkbox) and in `resolveReason` (the save). They must agree PER INVOICE, or the
// grid offers an amount the save refuses.
//
// They deliberately do NOT agree across a WHOLE GRID, and cannot: this function answers about one
// invoice at a time and measures the payment's entire unapplied cash against it, so a $1,000 check
// facing two $1,000 invoices renders "Take 20.00" on BOTH — that cash can settle either, just not
// both. Taking both is then refused by the payment's own unapplied-amount check inside
// `applyPaymentInTx`, which is the same upper bound the plain amount inputs have always had (the
// grid has never claimed a per-row figure is affordable alongside every other row's). The invariant
// that matters is the one-directional one, and it holds: every DISCOUNT the save ACCEPTS satisfies
// the condition this function offers on, so the save can never accept what the offer would refuse.
//
// The issue was originally ruled the other way — a pro-rata percentage of the cash remitted — and
// re-put to the owner with the arithmetic, because that reading strands $0.40 on the ordinary case
// (a $1,000 invoice at 2/10 settled by a $980 remittance) and contradicts both this phase's design
// spec and a pinned test.
// -------------------------------------------------------------------------------------------

type DiscountTerms = { discountPercent: Prisma.Decimal | null; discountDays: number | null };

/** The discount terms an invoice was ISSUED under, read off its own frozen columns (#79).
 *
 *  These used to come from `invoice.customer.terms` — the customer's terms RIGHT NOW — so moving a
 *  customer between terms rewrote what invoices already in their hands were worth: an invoice sent
 *  under `2/10 Net 30` lost its discount, and one sent under plain `Net 30` gained one it never
 *  offered. An invoice is frozen paper (§5.4); `termsName` always snapshotted the label, and these
 *  are the numbers behind it. A null pair means "no early-pay discount", exactly as it does on
 *  `Terms` — there is deliberately no fallback to the live relation, because a fallback is how the
 *  retroactive read would creep back in. */
function issuedTerms(invoice: {
  termsDiscountPercent: Prisma.Decimal | null; termsDiscountDays: number | null;
}): DiscountTerms {
  return { discountPercent: invoice.termsDiscountPercent, discountDays: invoice.termsDiscountDays };
}

/** Pure over already-read state — one definition shared by the public `discountAvailable` (which
 *  reads that state) and the DISCOUNT guard inside `applyPayment` (which already holds it under the
 *  claim), so the two can never drift. `settledOpen` is the invoice's open balance in dollars. */
function discountFor(terms: DiscountTerms | null, invoiceDate: Date, receivedDate: Date, settledOpen: number): number {
  if (!terms || terms.discountPercent === null || terms.discountDays === null) return 0;
  const deadline = addDays(invoiceDate, terms.discountDays);
  if (receivedDate.getTime() > deadline.getTime()) return 0;
  // Integer-cent, half-up: percent (2 = 2%) on the open-balance cents, then back to dollars.
  return Math.round((cents(settledOpen) * terms.discountPercent.toNumber()) / 100) / 100;
}

/**
 * The early-pay discount still available on this invoice — what `discountFor` offers, capped by the
 * entitlement not yet consumed.
 *
 * **Why the second cap exists (#81, Codex PR #129).** `discountFor` is a percentage of the CURRENT
 * open balance, and a discount reduces that balance — so each new request was offered a fresh, only
 * slightly smaller entitlement: $20 on a $1,000 invoice, then $19.60 of the remaining $980, then
 * $19.21… converging on the whole receivable. Capping the aggregate within one request (#81's first
 * half) did nothing about it, because every call started its tally at zero.
 *
 * The ceiling is the percentage of a **stable basis** — the invoice TOTAL, which never moves —
 * minus the DISCOUNT already taken. That makes the entitlement a one-time quantity instead of a
 * renewable one.
 *
 * **Deliberately the tighter of the two, never the looser.** After a partial payment, the open-balance
 * rule offers 2% of what remains (e.g. $10 on a half-paid $1,000 invoice) while the entitlement rule
 * alone would allow the full $20. Taking the minimum changes nothing in any case that works and closes
 * the one that does not — a hole closed, not a policy chosen.
 *
 * The basis question this docblock used to record as unruled was answered on 2026-08-19 (#69), and
 * the answer left this function alone: the eligible figure stays `percent × open balance`, and what
 * the owner added is the SETTLEMENT requirement enforced by the two callers (see the §4.3 block
 * above). Note the interaction, because it is not obvious — the guard makes a discount takeable only
 * alongside the payment that settles the invoice, which means the cross-request creep this cap was
 * built for can no longer be started. The cap stays as the belt: it is what refuses the second bite
 * after a void reopens an invoice whose entitlement is already spent.
 */
function remainingDiscountFor(
  terms: DiscountTerms | null, invoiceDate: Date, receivedDate: Date,
  total: number, apps: ApplicationLite[],
): number {
  const offered = discountFor(terms, invoiceDate, receivedDate, invoiceOpenBalance(total, apps));
  if (offered <= 0) return 0; // out of window, or no terms discount — nothing to cap
  const entitlement = discountFor(terms, invoiceDate, receivedDate, total);
  const consumed = apps
    .filter((a) => a.deletedAt === null && a.type === "DISCOUNT")
    .reduce((s, a) => s + cents(a.amount), 0);
  const remaining = cents(entitlement) - consumed;
  return Math.max(0, Math.min(cents(offered), remaining)) / 100;
}

export async function discountAvailable(paymentId: string, invoiceId: string): Promise<number> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId },
    select: {
      receivedDate: true, amount: true,
      // #69: the cash this receipt still has to spend — its amount less the PAYMENT applications
      // already sourced from it (`paymentOnAccount`). Cash it has spent on ANOTHER invoice cannot
      // settle this one.
      applications: { where: { deletedAt: null }, select: { amount: true, type: true, deletedAt: true } },
    },
  });
  if (!payment) throw new HttpError(404, "Payment not found");
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId },
    select: {
      invoiceDate: true, total: true,
      // #79: the invoice's OWN frozen pair, never the customer's current terms relation.
      termsDiscountPercent: true, termsDiscountDays: true,
      applications: { where: { deletedAt: null }, select: { amount: true, type: true, deletedAt: true } },
    },
  });
  if (!invoice) throw new HttpError(404, "Invoice not found");
  // The REMAINING entitlement, not the raw percentage — the UI must never offer an amount the save
  // will refuse (#81 / Codex PR #129).
  const apps = invoice.applications.map(toLite);
  const eligible = remainingDiscountFor(
    issuedTerms(invoice), invoice.invoiceDate, payment.receivedDate, invoice.total.toNumber(), apps);
  if (eligible <= 0) return 0;

  // #69: offered only if this payment can actually settle the invoice with it (see the block above).
  // This is a FEASIBILITY test — "is there enough cash left to close this out" — while the save's
  // half is an EXACTNESS test (`resolveReason`: the payload's cash + discount must equal the open
  // balance), because by then the operator has typed the figures. Integer cents: a cent short is
  // short, and `open − eligible` on floats is exactly where a 979.99 remittance would round its way
  // into a discount it did not earn.
  const openCents = cents(invoiceOpenBalance(invoice.total.toNumber(), apps));
  const cashCents = cents(paymentOnAccount(payment.amount.toNumber(), payment.applications.map(toLite)));
  return cashCents >= openCents - cents(eligible) ? eligible : 0;
}

/** One invoice's current open balance, by id — the same read `discountAvailable` already does,
 *  pulled out standalone (Task 13's batch-apply screen reads this ALONGSIDE `discountAvailable`
 *  for the same pair, via the GET route below, so the two live side by side rather than folding
 *  `discountAvailable`'s own return shape into `{ open, discount }` and rippling into its four
 *  direct callers in tests/applications.test.ts). */
export async function invoiceOpenBalanceById(invoiceId: string): Promise<number> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId },
    select: { total: true, applications: { where: { deletedAt: null }, select: { amount: true, type: true, deletedAt: true } } },
  });
  if (!invoice) throw new HttpError(404, "Invoice not found");
  return invoiceOpenBalance(invoice.total.toNumber(), invoice.applications.map(toLite));
}

// -------------------------------------------------------------------------------------------
// openInvoicesForPayer — Task 13's batch-apply screen (brief: "listing the payer's — and, when
// the payer has a parent/children, the family's — open finalized invoices"). Not part of the
// original Task 7 surface; added here because no other endpoint in this phase's plan ever
// surfaces a per-invoice open balance to the client — `GET /api/invoices` (5A) returns only
// `total`, and `aging.ts`/`statements.ts` report CUSTOMER-level buckets, never a pickable list of
// invoice ids. Read-only, gated `receivables.view` alone by the route below (no `invoicing.view`
// or `customers.view` coupling): family resolution happens HERE, not by asking the client to
// fetch the full customer list and infer it.
//
// Family = whichever of "the payer is a parent" / "the payer is a child" applies, unified into
// one rule: resolve the payer's OWN "root" (its parentId if it has one, else itself), then that
// root plus every live customer whose parentId is that root. A parent payer's root is itself
// (family = parent + children, the aging.ts/statements.ts rollup); a child payer's root is its
// parent (family = parent + every sibling, INCLUDING the payer — the aging.ts rollup starting
// from the parent's own id). A standalone customer's root is itself with no children — family of
// one. `[...new Set(...)]` because the payer is already included via one of the two branches
// above; de-duplicating rather than asserting keeps this correct even if that ever changes.
// -------------------------------------------------------------------------------------------

export type OpenInvoiceRow = {
  id: string; orderId: string; orderNumber: number; documentNumber: string;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; dueDate: string | null; total: number; open: number;
};

async function familyCustomerIds(customerId: string): Promise<string[]> {
  const payer = await prisma.customer.findFirst({
    where: { id: customerId, deletedAt: null }, select: { id: true, parentId: true },
  });
  if (!payer) throw new HttpError(404, "Customer not found");
  const rootId = payer.parentId ?? payer.id;
  const children = await prisma.customer.findMany({
    where: { parentId: rootId, deletedAt: null }, select: { id: true },
  });
  return [...new Set([rootId, payer.id, ...children.map((c) => c.id)])];
}

/** Every live, finalized INVOICE (never a CREDIT — `applyPayment` refuses those) belonging to
 *  exactly the given set of customer ids, with a positive open balance, oldest first — the
 *  "open item" filter `statements.ts`'s open-item table already established for this phase
 *  (`cents(open) <= 0` is fully settled, not an open item). `documentNumber` is the
 *  `invoices.ts`/`statements.ts` prefix + order-number rule, duplicated (private in both; the
 *  established precedent for this small a computation rather than a cross-module import). Shared
 *  by `openInvoicesForPayer` (family-resolved ids) and `openInvoicesForCustomer` (one id, no
 *  family resolution) below, so the query/map/filter logic can never drift between the two scopes
 *  — only which ids are passed in differs. */
async function openInvoicesForCustomerIds(customerIds: string[]): Promise<OpenInvoiceRow[]> {
  const prefix = await getSetting("invoice_number_prefix");
  const rows = await prisma.invoice.findMany({
    where: { customerId: { in: customerIds }, deletedAt: null, status: "FINALIZED", kind: "INVOICE" },
    select: {
      id: true, orderId: true, customerId: true, total: true, invoiceDate: true, dueDate: true,
      order: { select: { orderNumber: true } }, customer: { select: { code: true, name: true } },
      applications: { where: { deletedAt: null }, select: { amount: true, type: true, deletedAt: true } },
    },
    orderBy: [{ invoiceDate: "asc" }, { id: "asc" }],
  });
  return rows
    .map((r) => ({
      id: r.id, orderId: r.orderId, orderNumber: r.order.orderNumber,
      documentNumber: prefix === "" ? String(r.order.orderNumber) : `${prefix} - ${r.order.orderNumber}`,
      customerId: r.customerId, customerCode: r.customer.code, customerName: r.customer.name,
      invoiceDate: formatDateOnly(r.invoiceDate), dueDate: r.dueDate ? formatDateOnly(r.dueDate) : null,
      total: r.total.toNumber(), open: invoiceOpenBalance(r.total.toNumber(), r.applications.map(toLite)),
    }))
    .filter((r) => cents(r.open) > 0);
}

/** The payer's — and, when the payer has a parent/children, the family's — open finalized
 *  invoices (Task 13's batch-apply screen; unchanged by the Task 15 fix round below). */
export async function openInvoicesForPayer(customerId: string): Promise<OpenInvoiceRow[]> {
  const familyIds = await familyCustomerIds(customerId);
  return openInvoicesForCustomerIds(familyIds);
}

/** Exactly ONE customer's own open finalized invoices — never its family, even when that customer
 *  is a parent or a division with siblings (Task 15 fix round 1: the customer A/R section's own
 *  scope, `customer-receivables.ts`). `openInvoicesForPayer` above deliberately answers a
 *  different question — the PAYER's whole family, because a payment can settle across divisions —
 *  and must keep doing so for Task 13's apply screen; this is the single-customer sibling it was
 *  missing, not a behavior change to it. */
export async function openInvoicesForCustomer(customerId: string): Promise<OpenInvoiceRow[]> {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null }, select: { id: true } });
  if (!customer) throw new HttpError(404, "Customer not found");
  return openInvoicesForCustomerIds([customer.id]);
}

/**
 * ONE customer's complete open items — finalized invoices, open CREDIT memos, and on-account cash
 * (#83). The customer A/R section listed finalized invoices ALONE while the net above it folded in
 * credits and unapplied cash (`customerOwnAgingRow`), so the figure printed above the table could
 * not be arrived at from the rows in it: a customer holding nothing but a $200 credit read
 * "-$200.00" over the words "No open invoices".
 *
 * Credits and payments are NEGATIVE here, exactly as they reduce the net, so the rows SUM to it —
 * the same composition `buildStatement` makes for the printed document (§8, "open credits ... and
 * on-account as negatives"), and on the same bases: `invoiceOpenBalance` / `creditRemaining` /
 * `paymentOnAccount` from `ar-balances`, never re-derived here. Settled items drop out; a $0 row is
 * not an open item.
 *
 * `db` threads the caller's transaction so the items and the aging strip can be read from ONE
 * snapshot (`customer-receivables.ts`) — the `agingReport` RepeatableRead precedent — and `asOfDate`
 * MUST be the one that strip used, or the two describe different moments and stop reconciling.
 * Scoped to the
 * single customer, NEVER the family: `openInvoicesForPayer` deliberately answers the other question
 * for the batch-apply screen and must keep doing so.
 */
export type CustomerOpenItem = {
  kind: "INVOICE" | "CREDIT" | "PAYMENT";
  /** The invoice id, the credit's invoice id, or the payment id — what an apply action acts on. */
  id: string;
  documentNumber: string;
  date: string;
  dueDate: string | null;
  /** As raised: the invoice/credit total, or the payment's full amount. */
  original: number;
  /** Signed the way it moves the net: positive for an invoice, negative for a credit or cash. */
  open: number;
};

export async function openItemsForCustomer(
  customerId: string, db: Prisma.TransactionClient = prisma, asOfDate: Date = todayDateOnly(),
): Promise<CustomerOpenItem[]> {
  const customer = await db.customer.findFirst({
    where: { id: customerId, deletedAt: null }, select: { id: true },
  });
  if (!customer) throw new HttpError(404, "Customer not found");
  const prefix = await getSetting("invoice_number_prefix", db);

  // POINT-IN-TIME, matching `readSnapshotIn`/`bucketAging` cut for cut (review round 1). Nothing
  // stops a post-dated receipt — the receipt form takes a bare date — and the aging strip ignores
  // one, so an unfiltered read here put a row in the table that the net above it did not count. The
  // worse half was the APPLICATION: `appliedDate` follows the payment's `receivedDate`, so a
  // post-dated settlement reduced the table's invoice while the strip still showed it fully open,
  // and a full one produced an empty table reading "Nothing open — this customer is settled" beneath
  // a net of the entire receivable. Three cuts, because the strip applies three.
  const liveAsOf = { deletedAt: null, appliedDate: { lte: asOfDate } };
  // HALF-OPEN on `finalizedAt`, inclusive on the rest. `finalizedAt` is a bare `DateTime` carrying a
  // TIME OF DAY while `asOfDate` is midnight, so an inclusive `lte` would drop everything finalized
  // since midnight TODAY — while `bucketAging` compares date-only and includes it. CLAUDE.md
  // documents this exact trap for the GL export's month bound; it is the same bug one scope down.
  // `receivedDate`/`appliedDate` are `@db.Date`, so they stay inclusive.
  const finalizedThrough = addDays(asOfDate, 1);
  const invoices = await db.invoice.findMany({
    where: {
      customerId: customer.id, deletedAt: null, status: "FINALIZED",
      finalizedAt: { lt: finalizedThrough }, // not yet finalized as of this date never appears
    },
    select: {
      id: true, kind: true, creditNumber: true, total: true, invoiceDate: true, dueDate: true,
      order: { select: { orderNumber: true } },
      applications: { where: liveAsOf, select: { amount: true, type: true, deletedAt: true } },
      creditApplications: { where: liveAsOf, select: { amount: true, type: true, deletedAt: true } },
    },
    orderBy: [{ invoiceDate: "asc" }, { id: "asc" }],
  });

  const items: CustomerOpenItem[] = [];
  for (const inv of invoices) {
    const total = inv.total.toNumber();
    if (inv.kind === "INVOICE") {
      const open = invoiceOpenBalance(total, inv.applications.map(toLite));
      if (cents(open) <= 0) continue; // settled — not an open item
      items.push({
        kind: "INVOICE", id: inv.id,
        documentNumber: invoiceDocumentNumber("INVOICE", null, inv.order.orderNumber, prefix),
        date: formatDateOnly(inv.invoiceDate),
        dueDate: inv.dueDate ? formatDateOnly(inv.dueDate) : null,
        original: total, open,
      });
      continue;
    }
    // A CREDIT is drawn down through `creditApplications` (the applications that spend it), never
    // through `applications` (which would be reductions OF it, and a credit has none). A credit
    // carries no due date — `aging.ts`'s own rule.
    const remaining = creditRemaining(total, inv.creditApplications.map(toLite));
    if (cents(remaining) <= 0) continue;
    items.push({
      kind: "CREDIT", id: inv.id,
      documentNumber: invoiceDocumentNumber("CREDIT", inv.creditNumber, inv.order.orderNumber, prefix),
      date: formatDateOnly(inv.invoiceDate), dueDate: null,
      original: total, open: -remaining, // `creditRemaining` is already positive
    });
  }

  const payments = await db.payment.findMany({
    where: { customerId: customer.id, deletedAt: null, receivedDate: { lte: asOfDate } },
    select: {
      id: true, amount: true, reference: true, receivedDate: true,
      applications: { where: { ...liveAsOf, type: "PAYMENT" }, select: { amount: true } },
    },
    orderBy: [{ receivedDate: "asc" }, { id: "asc" }],
  });
  for (const pay of payments) {
    const amount = pay.amount.toNumber();
    // The SAME on-account basis `bucketAging` folds into `aging.unapplied` — a payment's cash less
    // what it has actually settled — so these rows and the strip above them reconcile by
    // construction rather than by coincidence.
    const applied = pay.applications.reduce((sum, a) => sum + a.amount.toNumber(), 0);
    const onAccount = paymentOnAccount(amount, [{ amount: applied, type: "PAYMENT", deletedAt: null }]);
    if (cents(onAccount) <= 0) continue;
    items.push({
      kind: "PAYMENT", id: pay.id,
      documentNumber: pay.reference !== "" ? pay.reference : "Payment on account",
      date: formatDateOnly(pay.receivedDate), dueDate: null,
      original: amount, open: -onAccount,
    });
  }
  return items;
}

// -------------------------------------------------------------------------------------------
// applyPayment — one call, one claim, many lines. See THE CLAIM above.
// -------------------------------------------------------------------------------------------

const APPLY = z.object({
  paymentId: z.string().min(1),
  lines: z.array(z.object({
    invoiceId: z.string().min(1),
    type: z.enum(["PAYMENT", "DISCOUNT", "WRITE_OFF"]),
    amount: decimalField(12, 2, { required: true, min: "positive" }),
    reason: z.string().max(4000).optional(),
  })).min(1),
}).strict();

type ApplyInput = z.infer<typeof APPLY>;
type ApplyLine = ApplyInput["lines"][number];

const INVOICE_CLAIM_SELECT = {
  id: true, total: true, invoiceDate: true, kind: true, status: true, deletedAt: true,
  // #79: frozen at finalize, read here — `applyPayment` caps the DISCOUNT line independently of
  // `discountAvailable`, so both sides have to read the same frozen pair or the save would still let
  // through a discount the paper never offered.
  termsDiscountPercent: true, termsDiscountDays: true,
  order: { select: { orderNumber: true } },
  applications: { where: { deletedAt: null }, select: { amount: true, type: true, deletedAt: true } },
} satisfies Prisma.InvoiceSelect;

type ClaimedInvoice = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_CLAIM_SELECT }>;

async function applyPaymentInTx(tx: Db, data: ApplyInput): Promise<void> {
  // (1) UNLOCKED stub reads — learn each target invoice's order, validate its liveness/kind/status.
  // `orderId`/`kind`/`status` cannot be trusted from here for the WRITE, but `orderId` never
  // changes (nothing updates it) so it is safe to CLAIM on; the guarded state (total + live
  // applications, AND kind/status/deletedAt) is RE-VALIDATED under the locks below. A discarded/
  // draft/credit target is refused now so no lock is taken for a target that can never be paid.
  const invoiceIds = [...new Set(data.lines.map((l) => l.invoiceId))];
  const stubs = await tx.invoice.findMany({
    where: { id: { in: invoiceIds } },
    select: { id: true, orderId: true, customerId: true, kind: true, status: true, deletedAt: true },
  });
  const stubById = new Map(stubs.map((s) => [s.id, s]));
  for (const id of invoiceIds) {
    const stub = stubById.get(id);
    if (!stub || stub.deletedAt !== null) throw new HttpError(404, "Invoice not found");
    if (stub.kind !== "INVOICE") {
      throw new HttpError(400, "That document is a credit, not an invoice — a payment applies to an invoice");
    }
    if (stub.status !== "FINALIZED") {
      throw new HttpError(400, "That invoice is not finalized — only a finalized invoice can take a payment");
    }
  }

  const paymentStub = await tx.payment.findFirst({
    where: { id: data.paymentId }, select: { id: true, customerId: true, deletedAt: true },
  });
  if (!paymentStub || paymentStub.deletedAt !== null) throw new HttpError(404, "Payment not found");

  // A payment settles only its own customer's family (§4.1 — one payment across a parent's
  // divisions, never an unrelated customer). Each target invoice's `customerId` must fall inside
  // the payer's family, else this call would settle customer B's balance with customer A's cash.
  // The invoice's `customerId` is frozen paper (nothing updates it), so validating it here in the
  // unlocked stub pass is sufficient — there is nothing to re-read under the claim.
  const payerFamily = new Set(await familyCustomerIds(paymentStub.customerId));
  for (const id of invoiceIds) {
    if (!payerFamily.has(stubById.get(id)!.customerId)) {
      throw new HttpError(400, "That invoice belongs to a customer outside this payment's family");
    }
  }

  // (2) Claim the orders behind the invoices — one sorted statement, dedup + ascending.
  await claimOrdersInOrder(tx, stubs.map((s) => s.orderId));

  // (3) Claim the invoice rows — one sorted `FOR UPDATE` statement, the SAME shape (this is the
  // lock that serializes applications to each invoice). `sortedClaimIds` dedups + sorts so the
  // statement is identical in form to `claimOrdersInOrder`'s.
  const sortedInvoiceIds = sortedClaimIds(invoiceIds);
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ANY(${sortedInvoiceIds}) ORDER BY "id" FOR UPDATE`;

  // (4) Claim the payment row last — the payment-on-account invariant is keyed here.
  await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${data.paymentId} FOR UPDATE`;

  // Now read the state the locks guard: the payment's amount + received date, and each invoice's
  // total, invoiceDate, terms, order number, kind/status/deletedAt, and LIVE applications.
  const payment = await tx.payment.findFirstOrThrow({
    where: { id: data.paymentId }, select: { amount: true, receivedDate: true, deletedAt: true },
  });
  // Re-check the payment UNDER its claim — a concurrent `voidPayment` committing between the stub
  // read and this claim would leave us writing PAYMENT applications against a voided receipt.
  if (payment.deletedAt !== null) throw new HttpError(404, "Payment not found");

  const invoices = await tx.invoice.findMany({ where: { id: { in: invoiceIds } }, select: INVOICE_CLAIM_SELECT });
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));

  // Re-validate every target invoice UNDER the invoice-row claim, with the SAME checks the unlocked
  // stub pass ran — a concurrent `unlockInvoice` (back to DRAFT) or `discardInvoice` committing
  // between the stub read and this claim would otherwise let a PAYMENT/DISCOUNT/WRITE_OFF settle
  // against now-editable or discarded paper. The stub's liveness/kind/status verdict "cannot be
  // trusted from here for the WRITE" (its own comment); this is where it becomes trustworthy.
  for (const id of invoiceIds) {
    const inv = invoiceById.get(id);
    if (!inv || inv.deletedAt !== null) throw new HttpError(404, "Invoice not found");
    if (inv.kind !== "INVOICE") {
      throw new HttpError(400, "That document is a credit, not an invoice — a payment applies to an invoice");
    }
    if (inv.status !== "FINALIZED") {
      throw new HttpError(400, "That invoice is not finalized — only a finalized invoice can take a payment");
    }
  }

  // (5) Validate every line BEFORE any write — a refusal rolls the whole call back, and the
  // over-application message must name the open balance available to the offending line. Running
  // applied-cents per invoice starts from the existing live sum and grows as this call's earlier
  // lines settle the same invoice.
  const appliedCents = new Map<string, number>(); // invoiceId -> Σ live + this-call-so-far, in cents
  for (const inv of invoices) {
    appliedCents.set(inv.id, inv.applications.reduce((s, a) => s + cents(a.amount.toNumber()), 0));
  }
  // invoiceId -> DISCOUNT cents accepted BY THIS CALL so far (#81). The per-line cap in
  // `resolveReason` derives `elig` from applications persisted BEFORE the call, so it recomputed the
  // SAME ceiling for every line of one request: fifty $20 lines each passed the $20 check while the
  // running open-balance guard above happily permitted the $1,000 aggregate, waiving the whole
  // receivable as an "early-pay discount". Keyed per invoice so one invoice's discount never
  // consumes another's entitlement in a multi-invoice apply.
  const discountCents = new Map<string, number>();

  // #69 (owner ruling 2026-08-19): a DISCOUNT is earned only by a payment that SETTLES the invoice,
  // so each DISCOUNT line is judged against what THIS WHOLE PAYLOAD covers of the invoice's open
  // balance — cash + discount, both totalled per invoice BEFORE the sequential loop below.
  //
  // The pre-aggregation is load-bearing, not tidiness. Derived inside the loop, "cash so far" would
  // make the verdict depend on the ORDER the lines arrive in: `[DISCOUNT, PAYMENT]` would be refused
  // while the identical `[PAYMENT, DISCOUNT]` passed. The DISCOUNT total is aggregated for the same
  // reason one level down — a split entitlement (`980 + 12 + 8`) must not be refused at its first
  // discount line for leaving 8.00 open.
  //
  // A WRITE_OFF deliberately does NOT count toward settling: the ruling earns the discount on a full
  // early PAYMENT, and a short-pay the shop absorbs is the opposite of being paid early. Such a
  // payload lands the invoice at zero and still earns nothing.
  const openAtCallCents = new Map<string, number>(); // invoiceId -> open balance BEFORE this call
  for (const inv of invoices) {
    openAtCallCents.set(inv.id, cents(inv.total.toNumber()) - appliedCents.get(inv.id)!);
  }
  const settlingCents = new Map<string, number>(); // invoiceId -> Σ this payload's PAYMENT + DISCOUNT
  for (const line of data.lines) {
    if (line.type !== "PAYMENT" && line.type !== "DISCOUNT") continue;
    settlingCents.set(line.invoiceId, (settlingCents.get(line.invoiceId) ?? 0) + cents(line.amount));
  }

  const resolved: { line: ApplyLine; invoice: ClaimedInvoice; reason: string }[] = [];
  let paymentLinesCents = 0;

  for (const line of data.lines) {
    const inv = invoiceById.get(line.invoiceId)!; // present — validated in the stub pass
    const lineCents = cents(line.amount);

    // Over-application against the invoice: Σ applications must never exceed the invoice total.
    const totalCents = cents(inv.total.toNumber());
    const alreadyCents = appliedCents.get(inv.id)!;
    const openCents = totalCents - alreadyCents;
    if (lineCents > openCents) {
      throw new HttpError(400, `That exceeds the invoice's open balance of ${openCents / 100}`);
    }

    const discountSoFar = discountCents.get(inv.id) ?? 0;
    const reason = resolveReason(line, inv, payment.receivedDate, discountSoFar, {
      coveredCents: settlingCents.get(inv.id) ?? 0, openCents: openAtCallCents.get(inv.id)!,
    });

    if (line.type === "PAYMENT") paymentLinesCents += lineCents;
    if (line.type === "DISCOUNT") discountCents.set(inv.id, discountSoFar + lineCents);
    appliedCents.set(inv.id, alreadyCents + lineCents);
    resolved.push({ line, invoice: inv, reason });
  }

  // Over-application of the payment: Σ new PAYMENT lines must fit the payment's remaining
  // on-account (amount − Σ existing live PAYMENT applications). No prepayments — on-account is only
  // ever an unapplied receipt, never a negative payment.
  const paymentApps = await tx.application.findMany({
    where: { paymentId: data.paymentId, deletedAt: null }, select: { amount: true, type: true, deletedAt: true },
  });
  const availableCents = cents(paymentOnAccount(payment.amount.toNumber(), paymentApps.map(toLite)));
  if (paymentLinesCents > availableCents) {
    throw new HttpError(400, `That exceeds the payment's unapplied amount of ${availableCents / 100}`);
  }

  // (6) Write every line. `appliedDate` = the payment's received date — the A/R-effective date the
  // point-in-time aging filter reads (Task 10). (A standalone bad-debt WRITE_OFF with NO payment
  // would use `todayDateOnly()`; `applyPayment` always carries a payment, so it is the received
  // date here.)
  const appliedDate = payment.receivedDate;
  // §4.1: an application is CASH-journal paper effective at `appliedDate` (the payment's received
  // date), so it is refused into a CLOSED period. Under the order/invoice/payment claims this tx
  // already holds, before any write — the advisory lock serializes it against a concurrent close of
  // that month (period-locks.ts).
  await assertPeriodOpen(tx, appliedDate);
  for (const { line, invoice, reason } of resolved) {
    const auditData = {
      invoiceId: line.invoiceId, invoiceOrderNumber: invoice.order.orderNumber,
      type: line.type, amount: line.amount, reason,
      paymentId: data.paymentId, appliedDate: formatDateOnly(appliedDate),
    };
    await auditedCreate("application", auditData, () => tx.application.create({
      data: {
        invoiceId: line.invoiceId, amount: line.amount, type: line.type, reason,
        paymentId: data.paymentId, appliedDate,
      },
      select: { id: true },
    }), { tx });
  }
}

/** The per-type reason rule: a WRITE_OFF requires a trimmed reason (§4.1); a DISCOUNT must fall
 *  inside the early-pay window, must SETTLE the invoice (#69), and always carries "early-pay terms";
 *  a PAYMENT carries whatever (optional) note was sent.
 *
 *  `discountSoFarCents` is the DISCOUNT already accepted for THIS invoice by THIS call — the
 *  aggregate half of the cap (#81). Passed in rather than re-derived because `invoice.applications`
 *  is the pre-call snapshot and cannot see the lines this request has already resolved.
 *
 *  `settlement` is the #69 pair, both pre-aggregated by the caller: what this whole payload's
 *  PAYMENT + DISCOUNT lines cover of this invoice, and the open balance they have to cover. */
function resolveReason(
  line: ApplyLine, invoice: ClaimedInvoice, receivedDate: Date, discountSoFarCents: number,
  settlement: { coveredCents: number; openCents: number },
): string {
  if (line.type === "WRITE_OFF") {
    const why = (line.reason ?? "").trim();
    if (!why) throw new HttpError(400, "a write-off needs a reason");
    return why;
  }
  if (line.type === "DISCOUNT") {
    // The REMAINING entitlement (#81, and Codex PR #129's cross-request half): a percentage of the
    // stable invoice total minus what has already been discounted, floored against the current
    // per-call offer. `discountSoFarCents` then adds this request's own accepted lines on top, so
    // the cap holds both WITHIN one payload and ACROSS separate calls.
    const elig = remainingDiscountFor(
      issuedTerms(invoice), invoice.invoiceDate, receivedDate,
      invoice.total.toNumber(), invoice.applications.map(toLite));
    if (elig <= 0) {
      throw new HttpError(400, "no early-pay discount applies");
    }
    // #69 (owner ruling 2026-08-19): earned only by a payment that SETTLES the invoice. Checked
    // AFTER the window/entitlement test above, so a genuine terms or window problem still reports
    // itself as one rather than as a settlement problem. `coveredCents` is this payload's whole
    // PAYMENT + DISCOUNT total for this invoice (never its WRITE_OFF — see the caller), so the
    // verdict does not depend on line order and a split discount is judged as one figure.
    if (settlement.coveredCents !== settlement.openCents) {
      throw new HttpError(400,
        "an early-pay discount is earned only by a payment that settles the invoice — this covers "
        + `${settlement.coveredCents / 100} of the ${settlement.openCents / 100} open`);
    }
    // Cap the AGGREGATE at the terms-derived eligible amount — the early-pay window opening does NOT
    // license waiving the whole receivable as a "discount". Per-line alone was not enough (#81):
    // `APPLY.lines` permits repeated lines against one invoice and `elig` is recomputed identically
    // for each, so fifty $20 lines each passed a $20 check and together waived $1,000. The operator
    // may still SPLIT the entitlement across lines (12 + 8 against a 20 cap is fine) — what is
    // refused is the total exceeding it. Integer cents to dodge float drift.
    if (discountSoFarCents + cents(line.amount) > cents(elig)) {
      throw new HttpError(400, `discount exceeds the eligible early-pay amount of ${elig}`);
    }
    return "early-pay terms";
  }
  return (line.reason ?? "").trim();
}

/**
 * `applyPayment` (§4.1). `tx` is optional — the public path opens its own Serializable transaction;
 * the discriminating concurrency test passes a manually-opened (Read Committed) transaction so the
 * INVOICE-ROW claim, not SSI, is what serializes a competing caller (the `createInvoice`/
 * `finalizeInvoice` shape).
 */
export async function applyPayment(input: unknown, tx?: Prisma.TransactionClient): Promise<void> {
  const data = APPLY.parse(input);
  if (tx) { await applyPaymentInTx(tx, data); return; }
  await withDbErrors({ entity: "Application" }, () => prisma.$transaction(
    (fresh) => applyPaymentInTx(fresh, data),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

// -------------------------------------------------------------------------------------------
// voidApplication — soft-delete under the invoice claim; the voided row drops out of every
// ar-balances sum, restoring the invoice open balance and (for a PAYMENT) the payment on-account,
// with no compensating write. Claim the invoice's order then the invoice row — the same order/
// invoice discipline every application takes — before re-reading and deleting.
// -------------------------------------------------------------------------------------------

async function voidApplicationInTx(tx: Db, id: string, reason: string): Promise<void> {
  // Unlocked stub — learn which invoice (hence which order) to claim; `invoiceId` never changes.
  const stub = await tx.application.findFirst({ where: { id }, select: { invoiceId: true } });
  if (!stub) throw new HttpError(404, "Application not found");
  const invoiceStub = await tx.invoice.findFirst({ where: { id: stub.invoiceId }, select: { orderId: true } });
  if (!invoiceStub) throw new HttpError(404, "Application not found");

  await claimOrder(tx, invoiceStub.orderId);
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${stub.invoiceId} FOR UPDATE`;

  // Re-read under the claim: the ordinary "already voided" 404 (auditedSoftDelete's own atomic
  // `updateMany` is the real guard, but the pre-check gives the well-labelled 404).
  const live = await tx.application.findFirst({ where: { id, deletedAt: null }, select: { id: true, appliedDate: true } });
  if (!live) throw new HttpError(404, "Application not found");

  // §4.1: voiding an application reverses paper effective at its `appliedDate`, so it is refused into
  // a CLOSED period. Under the order/invoice claims above, before the soft-delete (period-locks.ts).
  await assertPeriodOpen(tx, live.appliedDate);

  await auditedSoftDelete("application", id, reason, tx);
}

export async function voidApplication(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to void an application");
  await withDbErrors({ entity: "Application" }, () => prisma.$transaction(
    (tx) => voidApplicationInTx(tx, id, why),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

// -------------------------------------------------------------------------------------------
// applyCredit — apply a finalized CREDIT memo to a finalized INVOICE (Task 8, P5B §5: "a
// finalized credit memo applies to an invoice … or sits open on account"). Unlike `applyPayment`,
// the SOURCE here is a second guarded balance, not a fire-and-forget receipt: a credit's own
// `creditRemaining` (ar-balances.ts, `|total| − Σ live applications sourced from it`) must never
// be over-applied any more than the target invoice's open balance may. So THE CLAIM widens by one
// row rather than by a payment row:
//   1. UNLOCKED stub reads of both the target invoice and the credit — learn each row's `orderId`
//      (never changes once a row exists, so safe to CLAIM on) and validate liveness/kind/status;
//      the guarded state (total + live applications) is re-read under the locks below.
//   2. `claimOrdersInOrder(tx, [invoiceOrderId, creditOrderId])` — ONE sorted statement, dedup +
//      ascending (a credit shares its source invoice's `orderId` by construction — createCredit,
//      invoices.ts — but nothing stops it being applied to an invoice under a DIFFERENT order, so
//      the dedup is load-bearing, not dead code).
//   3. BOTH invoice rows — the target AND the credit — claimed FOR UPDATE in ONE sorted statement,
//      the identical shape `applyPaymentInTx` uses for its (single-kind) invoice set, taken AFTER
//      the order claims (fixed order: Order rows, then Invoice rows — unchanged; there is no
//      Payment row in this call, so no new ABBA counterpart to reorder against). The credit IS the
//      second guarded balance (house rule, order-locks.ts: "the guarded state must live on, or be
//      locked with, the claimed row") — there is no separate "payment row" claim step here.
// Only after both locks are held are the balances re-read and the over-application checks run,
// refusing on EITHER side before any write. Serializable, pairing with the FK-writer convention
// every 5A/5B mutator uses — the row claims, not the isolation level, are the guard.
// -------------------------------------------------------------------------------------------

const APPLY_CREDIT = z.object({
  creditInvoiceId: z.string().min(1),
  invoiceId: z.string().min(1),
  amount: decimalField(12, 2, { required: true, min: "positive" }),
}).strict();

type ApplyCreditInput = z.infer<typeof APPLY_CREDIT>;

const APPLICATIONS_LITE_SELECT = {
  amount: true, type: true, deletedAt: true,
} satisfies Prisma.ApplicationSelect;

async function applyCreditInTx(tx: Db, data: ApplyCreditInput): Promise<void> {
  // (1) UNLOCKED stub reads — the target invoice must be a live FINALIZED INVOICE; the source must
  // be a live FINALIZED CREDIT. Both live in the same `Invoice` table (kind discriminates), so
  // "Invoice not found" is the established 404 for either (documents.ts/invoices.ts precedent) —
  // a distinct "Credit not found" would just be the same row, differently worded.
  const invoiceStub = await tx.invoice.findFirst({
    where: { id: data.invoiceId },
    select: { id: true, orderId: true, customerId: true, kind: true, status: true, deletedAt: true },
  });
  if (!invoiceStub || invoiceStub.deletedAt !== null) throw new HttpError(404, "Invoice not found");
  if (invoiceStub.kind !== "INVOICE") {
    throw new HttpError(400, "That document is a credit, not an invoice — a credit applies to an invoice");
  }
  if (invoiceStub.status !== "FINALIZED") {
    throw new HttpError(400, "That invoice is not finalized — only a finalized invoice can take a credit");
  }

  const creditStub = await tx.invoice.findFirst({
    where: { id: data.creditInvoiceId },
    select: { id: true, orderId: true, customerId: true, kind: true, status: true, deletedAt: true },
  });
  if (!creditStub || creditStub.deletedAt !== null) throw new HttpError(404, "Invoice not found");
  if (creditStub.kind !== "CREDIT") {
    throw new HttpError(400, "That document is an invoice, not a credit — only a credit can be applied");
  }
  if (creditStub.status !== "FINALIZED") {
    throw new HttpError(400, "only a finalized credit can be applied");
  }

  // A credit applies only within its OWN customer's family (§4.1/§5) — never to an unrelated
  // customer. Both `customerId`s are frozen paper (nothing updates them), so validating here in the
  // unlocked stub pass is sufficient — there is nothing to re-read under the claim.
  const creditFamily = new Set(await familyCustomerIds(creditStub.customerId));
  if (!creditFamily.has(invoiceStub.customerId)) {
    throw new HttpError(400, "That invoice belongs to a customer outside this credit's family");
  }

  // (2) Claim the orders behind both rows — one sorted statement, dedup + ascending.
  await claimOrdersInOrder(tx, [invoiceStub.orderId, creditStub.orderId]);

  // (3) Claim BOTH invoice rows — one sorted `FOR UPDATE` statement, the same shape
  // `applyPaymentInTx` uses for its invoice set, taken AFTER the order claims. This is what
  // serializes two applications drawing on the SAME credit (or targeting the SAME invoice).
  const sortedIds = sortedClaimIds([data.invoiceId, data.creditInvoiceId]);
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ANY(${sortedIds}) ORDER BY "id" FOR UPDATE`;

  // Now read the state the locks guard: the target's total + live applications, and the credit's
  // total + live applications SOURCED FROM IT (`creditApplications`, the `CreditApplications`
  // relation — distinct from `applications`, which is what's applied TO a row). Kind/status/
  // deletedAt come too, so the stub verdict can be RE-VALIDATED under the claim (below).
  const invoice = await tx.invoice.findFirstOrThrow({
    where: { id: data.invoiceId },
    select: {
      kind: true, status: true, deletedAt: true, total: true,
      applications: { where: { deletedAt: null }, select: APPLICATIONS_LITE_SELECT },
    },
  });
  const credit = await tx.invoice.findFirstOrThrow({
    where: { id: data.creditInvoiceId },
    select: {
      kind: true, status: true, deletedAt: true, total: true,
      creditApplications: { where: { deletedAt: null }, select: APPLICATIONS_LITE_SELECT },
    },
  });

  // Re-validate BOTH rows UNDER the invoice-row claim, with the SAME checks the unlocked stub pass
  // ran — a concurrent `unlockInvoice`/`discardInvoice` on the target, or an unlock/discard of the
  // credit, committing between the stubs and this claim would otherwise let a CREDIT settle against
  // now-editable/discarded paper or draw on a no-longer-finalized credit.
  if (invoice.deletedAt !== null) throw new HttpError(404, "Invoice not found");
  if (invoice.kind !== "INVOICE") {
    throw new HttpError(400, "That document is a credit, not an invoice — a credit applies to an invoice");
  }
  if (invoice.status !== "FINALIZED") {
    throw new HttpError(400, "That invoice is not finalized — only a finalized invoice can take a credit");
  }
  if (credit.deletedAt !== null) throw new HttpError(404, "Invoice not found");
  if (credit.kind !== "CREDIT") {
    throw new HttpError(400, "That document is an invoice, not a credit — only a credit can be applied");
  }
  if (credit.status !== "FINALIZED") {
    throw new HttpError(400, "only a finalized credit can be applied");
  }

  // Refuse over-application on EITHER side before any write.
  const remainingCents = cents(creditRemaining(credit.total.toNumber(), credit.creditApplications.map(toLite)));
  const amountCents = cents(data.amount);
  if (amountCents > remainingCents) {
    throw new HttpError(400, `That exceeds the credit's remaining of ${remainingCents / 100}`);
  }
  const openCents = cents(invoiceOpenBalance(invoice.total.toNumber(), invoice.applications.map(toLite)));
  if (amountCents > openCents) {
    throw new HttpError(400, `That exceeds the invoice's open balance of ${openCents / 100}`);
  }

  // A credit application carries no source payment — it ages from today, the standalone
  // (no-payment) `todayDateOnly()` rule `applyPaymentInTx`'s own header comment documents but never
  // reaches (every PAYMENT/DISCOUNT/WRITE_OFF line there carries a payment's received date).
  const appliedDate = todayDateOnly();
  // §4.1: a credit application is paper effective at `appliedDate` (today), so it is refused into a
  // CLOSED period. Under the order/invoice claims this tx already holds, before the audited create
  // (period-locks.ts).
  await assertPeriodOpen(tx, appliedDate);
  const auditData = {
    type: "CREDIT", invoiceId: data.invoiceId, creditInvoiceId: data.creditInvoiceId,
    paymentId: null, amount: data.amount, appliedDate: formatDateOnly(appliedDate),
  };
  await auditedCreate("application", auditData, () => tx.application.create({
    data: {
      invoiceId: data.invoiceId, creditInvoiceId: data.creditInvoiceId, paymentId: null,
      amount: data.amount, type: "CREDIT", appliedDate,
    },
    select: { id: true },
  }), { tx });
}

/** `applyCredit` (§5). One call, one credit, one target invoice — unlike `applyPayment` there is
 *  no multi-line batch shape here (a credit is a single source applied to a single target). */
export async function applyCredit(input: { creditInvoiceId: string; invoiceId: string; amount: number }): Promise<void> {
  const data = APPLY_CREDIT.parse(input);
  await withDbErrors({ entity: "Application" }, () => prisma.$transaction(
    (tx) => applyCreditInTx(tx, data),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}
