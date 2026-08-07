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
