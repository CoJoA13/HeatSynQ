// A LEAF, deliberately: orders.ts and shippers.ts must be able to ask "is this order invoiced?"
// without importing invoices.ts, which imports both of them. Phase 4 lesson 3 — a `const`
// consumed across a module cycle crashes at module-evaluation time, two tasks after the edge is
// added — and order-locks.ts is the precedent for pulling the shared question into a leaf BEFORE
// the cycle exists rather than after it bites. `errors.ts` was the first; this is the third.
//
// It throws nothing of its own. The question ("which invoice blocks this?") and the sentence that
// names it live here; the `HttpError` each caller raises stays at the call site, where the right
// status code and the surrounding claim both live. That is what keeps this file importable from
// anywhere without dragging a service graph behind it — the import-shape test in
// tests/invoice-guards.test.ts pins it.
import type { Prisma } from "../../prisma/generated/prisma/client";
// The ONE non-type import, and a leaf-to-leaf edge: period-locks.ts imports only `type Prisma` and
// the `HttpError` leaf, and imports nothing from here or from any service, so this adds no cycle.
// `closedMonthsForDisplay` is the LOCK-FREE read — see its docblock; nothing in this file guards a
// write with it.
import { closedMonthsForDisplay, periodLabel } from "./period-locks";

export type FinalizedInvoice = { id: string; orderId: string; orderNumber: number };

/** Every guard below asks the same question of the same rows; stated once so a later edit cannot
 *  drift one call site's definition of "frozen" away from the other's.
 *
 *  - `kind: "INVOICE"` — a CREDIT reverses an invoice, it is not one, and it freezes nothing
 *    (P5A design §5.6: a credit is precisely the correction you raise AGAINST frozen paper, so a
 *    guard that treated it as a freeze would block the only fix it offers).
 *  - `status: "FINALIZED"` — a DRAFT is still being assembled and owns nothing yet (§5.5).
 *  - `deletedAt: null` — a discarded draft is gone. */
const FROZEN = { kind: "INVOICE", status: "FINALIZED", deletedAt: null } as const;

const SELECT = { id: true, orderId: true, order: { select: { orderNumber: true } } } as const;

type Row = { id: string; orderId: string; order: { orderNumber: number } };

const toGuard = (r: Row): FinalizedInvoice =>
  ({ id: r.id, orderId: r.orderId, orderNumber: r.order.orderNumber });

/**
 * The live, FINALIZED invoice for this order, if any — `null` means nothing is frozen.
 *
 * Read on the CALLER'S OWN `tx`, which is already holding that order's claim (`claimOrder` /
 * `claimOrdersInOrder`, order-locks.ts): the check and the write it guards must see the same
 * state. Never call it on the bare `prisma` client for a guard.
 *
 * The order-locks house rule — the guarded state must live on, or be locked with, the claimed row
 * — puts an obligation on the OTHER side, not on this one: `Invoice.status` lives on the Invoice
 * row, so every writer of it (finalize and unlock) must claim the invoice's Order row before it
 * writes. Then the two sides serialize through that one lock and no finalize can commit inside the
 * window between this read and the write it guards. That is the contract this function rests on.
 *
 * `findFirst`, not `findUnique`: `@@unique([orderId])` on Invoice is filtered on
 * `deletedAt IS NULL AND kind = 'INVOICE'`, so the generated client still types a plain unique it
 * cannot actually honour (CLAUDE.md's partial-unique rule). The same index is what guarantees this
 * `findFirst` sees at most one row.
 */
export async function finalizedInvoiceFor(
  tx: Prisma.TransactionClient, orderId: string,
): Promise<FinalizedInvoice | null> {
  const row = await tx.invoice.findFirst({ where: { orderId, ...FROZEN }, select: SELECT });
  return row === null ? null : toGuard(row);
}

/**
 * The batched form, for a mutator spanning several orders (every shipment mutator; Task 15's
 * reversing shipment). One query, not one per order — the `shippedTotals` shape.
 *
 * Ordered by order number, ascending, so the ONE invoice a refusal names off `[0]` is the same one
 * every time: scan order is not a contract, and a message that changes between identical attempts
 * is a message nobody trusts.
 */
export async function finalizedInvoicesFor(
  tx: Prisma.TransactionClient, orderIds: string[],
): Promise<FinalizedInvoice[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.invoice.findMany({
    where: { orderId: { in: orderIds }, ...FROZEN },
    select: SELECT,
    orderBy: { order: { orderNumber: "asc" } },
  });
  return rows.map(toGuard);
}

/** Names the blocker and links to it — §5.14's discoverability rule, the shape every shipment
 *  refusal in Phase 4 already uses ("Packing List 072826, linked to its page"). An invoice carries
 *  no number column of its own: its identifier IS the order number (P5A design §10 — the paper's
 *  `Invoice No.` is `invoice_number_prefix` + the order number), which is why discarding a draft
 *  "frees the order number for a new invoice" (§5.5). That prefix is a print-time setting and is
 *  deliberately NOT read here — reading it would mean importing settings.ts, and this module stays
 *  a leaf; the bare number is unambiguous on screen. */
export function invoiceBlockMessage(inv: FinalizedInvoice, action: string): string {
  return `${action} — Invoice ${inv.orderNumber} is finalized; unlock it or raise a credit ` +
    `(see /invoicing/${inv.id})`;
}

/**
 * The tail every `hasReceivableActivity` refusal carries — §5.14's rule that a block must name the
 * route out of itself.
 *
 * It exists because of #77. Before the standalone bad-debt write-off there was no way to create a
 * WRITE_OFF without a payment, so "void the payment" was always a true instruction; now a
 * null-payment write-off reaches all three refusals (this guard has never had a `type` or
 * `paymentId` predicate — correctly), and that instruction sends the operator to the receipt
 * batches to void a payment that does not exist. `BatchDetail` lists applications per PAYMENT, so
 * the only screen that can reach this one is the customer's Receivables section.
 *
 * Stated once rather than repeated in three services, because the three sentences must keep naming
 * the same destination: if the void surface ever moves, this is the single line that has to move
 * with it.
 *
 * **MODULE-PRIVATE since #157, deliberately.** The destination is no longer unconditional — a
 * write-off whose own month has closed cannot be voided there at all — so every refusal site now
 * goes through `applicationVoidHint` / `applicationVoidHintForOrder` below, which return exactly this
 * sentence in the ordinary case and widen it only when the route really is blocked. Un-exporting it
 * is what makes "append the unconditional sentence" un-typeable rather than merely discouraged.
 */
const WRITE_OFF_VOID_ROUTE = "a bad-debt write-off is voided from the customer's Receivables section";
const WRITE_OFF_VOID_HINT = ` (${WRITE_OFF_VOID_ROUTE})`;

/** The rows the hint is about: LIVE, standalone (null-payment) write-offs. A residual write-off is
 *  voided from its receipt batch, where no period wording of ours applies, so it is not in scope. */
const LIVE_STANDALONE_WRITE_OFF = { deletedAt: null, type: "WRITE_OFF", paymentId: null } as const;

/**
 * The §5.14 hazard #157 made worse, and the reason this is a function and not a constant.
 *
 * `voidApplication` guards `assertPeriodOpen(appliedDate)`, so the Receivables section this sentence
 * names refuses a write-off whose own month has closed — and the REACHABLE case is ordinary, not
 * exotic: `unlockInvoice` guards the invoice's `finalizedAt` while a write-off is dated at its own
 * creation, so a July-finalized invoice with an August write-off in a closed August passes unlock's
 * period guard, gets refused for the write-off, and sends the operator to a screen that refuses them
 * again. Since #157 the row is not even listed there.
 *
 * So the sentence names the route that ACTUALLY exists. Unchanged — byte for byte — while every
 * standalone write-off in scope is still voidable (the common case, and the one the three services'
 * existing messages and tests pin); widened to name the closed month, and the reopen, only when at
 * least one is not. Appending "or reopen the period" unconditionally would be cheaper and is the
 * wrong trade: it points the common case at a heavyweight month reopen it does not need, which is
 * §5.14's other failure — naming the wrong route.
 *
 * Read on the CALLER'S OWN `tx`, under the claim it already holds, exactly like the guards above;
 * the period read is `period-locks.ts`'s LOCK-FREE `closedMonthsForDisplay`, never `closedPeriodFor`
 * — this decides WORDING, not whether a write may happen, and taking the month's advisory lock to
 * phrase a refusal would serialize it against a running close for nothing. That import is the only
 * one this module has beyond `type Prisma`, and `period-locks.ts` is itself a leaf that imports
 * neither this file nor any service, so the edge adds no cycle.
 */
async function applicationVoidHintFor(
  tx: Prisma.TransactionClient, scope: Prisma.ApplicationWhereInput,
): Promise<string> {
  const rows = await tx.application.findMany({
    where: { ...LIVE_STANDALONE_WRITE_OFF, ...scope }, select: { appliedDate: true },
  });
  // No standalone write-off in scope (a payment or a credit is what blocked): "every one of them is
  // still voidable" holds vacuously, and the sentence stays as it reads today.
  if (rows.length === 0) return WRITE_OFF_VOID_HINT;
  const closed = await closedMonthsForDisplay(tx, rows.map((r) => r.appliedDate));
  if (closed.size === 0) return WRITE_OFF_VOID_HINT;
  // Ascending, and ALL of them — the `finalizedInvoicesFor` rule that a refusal must not change
  // wording between identical attempts, plus the plain fact that naming one of two closed months
  // would leave the operator to discover the second the hard way.
  const months = [...closed.values()]
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .map(periodLabel);
  const one = months.length === 1;
  return ` (${WRITE_OFF_VOID_ROUTE}, but ${one ? "period" : "periods"} ${months.join(", ")} `
    + `${one ? "is" : "are"} closed — reopen ${one ? "it" : "them"} first)`;
}

/** Per-INVOICE, the `hasReceivableActivity` scope — `discardInvoice` and `unlockInvoice`. Only the
 *  `invoiceId` arm: a write-off never carries a `creditInvoiceId`, so the credit arm cannot hold
 *  one. */
export function applicationVoidHint(tx: Prisma.TransactionClient, invoiceId: string): Promise<string> {
  return applicationVoidHintFor(tx, { invoiceId });
}

/** Per-ORDER, the `hasReceivableActivityForOrder` scope — `voidOrder`, which blocks on any
 *  invoice-family document on the order. A write-off names an INVOICE, so it reaches through that
 *  relation; the credit arm of the guard contributes none. */
export function applicationVoidHintForOrder(tx: Prisma.TransactionClient, orderId: string): Promise<string> {
  return applicationVoidHintFor(tx, { invoice: { orderId } });
}

/**
 * Does this invoice carry LIVE accounts-receivable activity — a payment, early-pay discount, or
 * write-off applied TO it, or a credit that has been applied AGAINST it? `unlockInvoice`,
 * `discardInvoice` and `voidOrder` refuse while it does (P5B §5.3): editing, discarding, or voiding
 * paper that money has already been applied to would silently strand that `Application`. The
 * correction the refusals name is to VOID the application first.
 *
 * Two arms, because an `Application` touches an invoice from both sides:
 *   - `invoiceId = this` — a PAYMENT / DISCOUNT / WRITE_OFF (or an applied credit's target line)
 *     reducing THIS invoice's open balance;
 *   - `creditInvoiceId = this` — THIS row is a CREDIT that has been applied against some invoice, so
 *     it is active paper of its own (§4.2 reads the credit's remaining off exactly these rows).
 * A voided (soft-deleted) `Application` drops out of both arms, exactly as it drops out of every
 * `ar-balances` sum — so voiding the application genuinely re-permits the mutation.
 *
 * Read on the CALLER'S OWN `tx`, under the order (and invoice-row) claim it already holds — the same
 * discipline `finalizedInvoiceFor` documents above. `applyPayment`/`applyCredit` write these rows
 * under the SAME order claim, so this read and the mutation it guards serialize through that lock and
 * no application can commit inside the window between them. No new lock is taken here.
 *
 * A single existence query — the guard cares only WHETHER any live row exists, never how much or
 * what type (that is `ar-balances`' job), so `select: { id }` and a boolean is the whole contract.
 */
export async function hasReceivableActivity(
  tx: Prisma.TransactionClient, invoiceId: string,
): Promise<boolean> {
  const row = await tx.application.findFirst({
    where: { deletedAt: null, OR: [{ invoiceId }, { creditInvoiceId: invoiceId }] },
    select: { id: true },
  });
  return !!row;
}

/**
 * The ORDER-level companion: does ANY invoice-family document on this order — an INVOICE **or** a
 * CREDIT — carry live A/R activity? `voidOrder` asks this, not `hasReceivableActivity` on the order's
 * finalized INVOICE, because a finalized CREDIT lives on the same order (`createCredit` copies
 * `orderId: source.orderId`) and can hold a live application even after that INVOICE is unlocked back
 * to DRAFT — at which point `finalizedInvoiceFor` returns null and the per-invoice guard would never
 * run, orphaning the credit's live application on a voided order (§5.3).
 *
 * Both arms walk the Application → invoice / Application → creditInvoice relations to `orderId`:
 *   - `invoice.orderId = this` — a payment/discount/write-off/applied-credit reducing an INVOICE on
 *     this order;
 *   - `creditInvoice.orderId = this` — a CREDIT raised on this order that has been applied against
 *     some invoice (possibly on ANOTHER order — cross-order application is supported).
 * A voided (soft-deleted) `Application` drops out of both arms. Read on the caller's own `tx` under
 * the order claim it already holds; a relation filter keeps this a single existence query and the
 * module a leaf (only `type Prisma` imported).
 */
export async function hasReceivableActivityForOrder(
  tx: Prisma.TransactionClient, orderId: string,
): Promise<boolean> {
  const row = await tx.application.findFirst({
    where: { deletedAt: null, OR: [{ invoice: { orderId } }, { creditInvoice: { orderId } }] },
    select: { id: true },
  });
  return !!row;
}
