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
