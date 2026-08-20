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
 * The ROUTE clause of the tail every `hasReceivableActivity` refusal carries — §5.14's rule that a
 * block must name the route out of itself.
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
 * IT SPEAKS FOR EXACTLY ONE KIND, and always has: a payment and a residual (payment-sourced)
 * write-off are voided from their receipt batch, not here. That is why it survives #173's widening
 * unaltered — see the two-clause rule on `applicationVoidHintFor`.
 *
 * **MODULE-PRIVATE since #157, deliberately.** The sentence is no longer unconditional — what is
 * applied in a closed month cannot be voided anywhere — so every refusal site goes through
 * `applicationVoidHint` / `applicationVoidHintForOrder` below, which return exactly this sentence in
 * the ordinary case and add to it only when something in scope really is blocked. Un-exporting it is
 * what makes "append the unconditional sentence" un-typeable rather than merely discouraged.
 */
const WRITE_OFF_VOID_ROUTE = "a bad-debt write-off is voided from the customer's Receivables section";
const WRITE_OFF_VOID_HINT = ` (${WRITE_OFF_VOID_ROUTE})`;

/**
 * The rows all three refusals actually fire on: LIVE applications reaching this invoice from EITHER
 * side. Stated ONCE and consumed by both the boolean guard (`hasReceivableActivity`) and the hint,
 * so the sentence can never describe a set the guard did not consider — and, the direction #173 was
 * filed for, can never fall SILENT about one it did.
 *
 * The two arms and why each is here are documented on `hasReceivableActivity` below; this is the
 * same predicate hoisted, not a second opinion about it.
 */
const liveActivityForInvoice = (invoiceId: string): Prisma.ApplicationWhereInput =>
  ({ deletedAt: null, OR: [{ invoiceId }, { creditInvoiceId: invoiceId }] });

/** The ORDER-level companion — `hasReceivableActivityForOrder`'s two arms, hoisted for the same
 *  reason and consumed by the same pair. */
const liveActivityForOrder = (orderId: string): Prisma.ApplicationWhereInput =>
  ({ deletedAt: null, OR: [{ invoice: { orderId } }, { creditInvoice: { orderId } }] });

/**
 * The §5.14 hazard, and the reason this is a function and not a constant.
 *
 * `voidApplicationInTx` guards `assertPeriodOpen(live.appliedDate)` with NO type or `paymentId`
 * predicate, so anything the three refusals fire on may already be un-voidable — and the REACHABLE
 * case is ordinary, not exotic: `unlockInvoice` guards the INVOICE's `finalizedAt` while an
 * application is dated at its own event, so a July-finalized invoice carrying an August payment in a
 * closed August passes unlock's period guard, is refused for the payment, and is sent to a screen
 * that refuses it again.
 *
 * **EVERY CLAUSE MUST BE TRUE OF THE SET IN SCOPE** (#173; #157 shipped one that was true of only
 * part of what it described). Two clauses, deliberately sharing no subject:
 *
 *  1. **the ROUTE clause** — where a standalone bad-debt write-off is voided. A standing fact about
 *     ONE kind, stated as one, and asserted of nothing in scope: a payment and a residual write-off
 *     are voided from their receipt batch. It rides on every refusal exactly as it did before #157,
 *     which is why the common-case sentence stays byte-identical to the one three services' tests
 *     already pin — including on a payment-only refusal, where it is navigation rather than an
 *     instruction about the blocking row.
 *  2. **the PERIOD clause** — which months among the rows in scope are closed, and that what is
 *     applied in them cannot be voided until they are reopened. TRUE OF EVERY KIND, because the
 *     guard it restates is kind-blind. So the scope read here is the caller's own guard predicate,
 *     never a write-off filter (that was #173: scoped to standalone write-offs, the sentence went
 *     silent about the cash that was actually blocking you — and cash is the commoner blocker).
 *
 * A semicolon, not the ", but … — reopen it first" #157 used: that chained the obstacle onto the
 * route just named, which reads as though the Receivables section were what the closed month blocks
 * — false the moment the closed-month row is a payment. **Do not try to name a destination per kind
 * here.** A mixed set (a payment and two write-offs across two closed months) turns that into a
 * sentence nobody reads; the months and the reopen are what every kind has in common.
 *
 * Appending a reopen unconditionally would be cheaper and is the wrong trade: it points the common
 * case at a heavyweight month reopen it does not need, which is §5.14's other failure — naming the
 * wrong route.
 *
 * **ON THE REFUSAL PATH ONLY.** All three call sites compute this INSIDE the `if`, in the `throw`
 * expression; a successful discard/unlock/void must not pay for two reads it will not use. Pinned by
 * a query counter in tests/write-offs.test.ts.
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
  const rows = await tx.application.findMany({ where: scope, select: { appliedDate: true } });
  // Nothing in scope is in a closed month — or, on a caller whose guard did not actually fire,
  // nothing is in scope at all (`closedMonthsForDisplay` answers an empty list without a query).
  // Either way "what is applied here can still be voided" holds, and the sentence stays as it reads.
  const closed = await closedMonthsForDisplay(tx, rows.map((r) => r.appliedDate));
  if (closed.size === 0) return WRITE_OFF_VOID_HINT;
  // Ascending, and ALL of them — the `finalizedInvoicesFor` rule that a refusal must not change
  // wording between identical attempts, plus the plain fact that naming one of two closed months
  // would leave the operator to discover the second the hard way.
  const months = [...closed.values()]
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .map(periodLabel);
  const one = months.length === 1;
  return ` (${WRITE_OFF_VOID_ROUTE}; what is applied in ${one ? "period" : "periods"} `
    + `${months.join(", ")} cannot be voided until `
    + `${one ? "that period is" : "those periods are"} reopened)`;
}

/** Per-INVOICE — `discardInvoice` and `unlockInvoice`, whose guard is `hasReceivableActivity`. The
 *  SAME predicate, both arms: the hint must see exactly the rows that refused the caller. */
export function applicationVoidHint(tx: Prisma.TransactionClient, invoiceId: string): Promise<string> {
  return applicationVoidHintFor(tx, liveActivityForInvoice(invoiceId));
}

/** Per-ORDER — `voidOrder`, whose guard is `hasReceivableActivityForOrder`. The same predicate
 *  again, both arms, so the order-scoped sentence and the order-scoped guard cannot disagree. */
export function applicationVoidHintForOrder(tx: Prisma.TransactionClient, orderId: string): Promise<string> {
  return applicationVoidHintFor(tx, liveActivityForOrder(orderId));
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
 * **A boolean and nothing else**: the sentence the caller raises is `applicationVoidHint`'s job, and
 * the two share `liveActivityForInvoice` rather than this function growing a second return value.
 */
export async function hasReceivableActivity(
  tx: Prisma.TransactionClient, invoiceId: string,
): Promise<boolean> {
  const row = await tx.application.findFirst({
    where: liveActivityForInvoice(invoiceId),
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
    where: liveActivityForOrder(orderId),
    select: { id: true },
  });
  return !!row;
}
