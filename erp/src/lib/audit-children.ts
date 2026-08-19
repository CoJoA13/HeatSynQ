// Client-safe leaf (the permission-constants / audit-diff precedent — no src/server imports):
// the parent → child-section map behind #153's union history read. `readAuditWithChildren`
// (src/server/audit.ts) walks it to resolve child row ids; HistoryPanel imports it to LABEL the
// foreign rows it renders. Both ends read the same registry, so a panel can never show a row it
// cannot name.
//
// WHY A REGISTRY. A parent's History panel has always been an exact `(entity, entityId)` match,
// while every child section writes its audit rows under its OWN entity and id — so a price edit,
// an address rename or a spec swap has never appeared on the parent's panel. The fix is a union,
// and the union has to be data: per-kind code would mean the next audited child is a new function
// nobody remembers to write. Adding one here is the whole change.

/**
 * One hop UP the ownership chain, child-first. `model` is the Prisma model whose rows the hop
 * holds (camelCase — it is the delegate key on the client); `fk` is the scalar column ON that
 * model pointing one level up: at the next hop's model, or, for the LAST hop of a path, at the
 * parent's own id.
 *
 * Resolution walks a path in reverse (parent id → … → child ids) and **never filters
 * `deletedAt`** — a child's own DELETE entry is precisely the row the panel most needs, and a
 * live-rows-only walk would hide every deletion the section ever made, including the deletion of
 * an intermediate hop (a break whose parent price was itself soft-deleted).
 *
 * Names are plain strings because this file must stay importable from the browser bundle, so a
 * typo cannot be caught by Prisma's types here. `tests/audit-children.test.ts` executes every
 * `(model, fk)` pair against the real schema instead (the snapshot-order-sweep precedent),
 * INDIVIDUALLY rather than by walking a chain — a chain walk from a bogus parent id stops at the
 * first hop and would leave every INNER hop of a multi-hop path unvalidated — and asserts that
 * the set of pairs it executed is the whole registry, so the sweep cannot quietly stop covering
 * one. That is what catches a wrong model or column at test time rather than at the first panel
 * load.
 */
export type AuditChildHop = { model: string; fk: string };

/**
 * One child SECTION of a parent's page. `entity` is the audit entity its rows carry (an
 * `AuditableModel` — audit.ts asserts that at compile time), `label` is what the panel prints
 * beside a foreign row, and `paths` are the ownership chains that reach it.
 *
 * `paths` is a LIST because one child can hang off its parent by more than one FK — an
 * `Application` is reachable from an `Invoice` both as the invoice it reduces (`invoiceId`) and
 * as the credit memo it spends (`creditInvoiceId`). Both are the same section, so they share one
 * spec and one label, and the id sets union into a Set before any query runs: an application
 * matching BOTH ends is listed once, not twice.
 */
export type AuditChildSpec = {
  entity: string;
  label: string;
  paths: readonly (readonly AuditChildHop[])[];
};

/**
 * Parent audit entity → the child sections that roll into its History panel.
 *
 * SCOPE (controller call, 2026-08-19 — do not widen without a ruling):
 *  - `storedDocument` rows do NOT roll into any panel. Every page that prints already lists its
 *    prints in its own DocumentsSection, and one row per reprint would drown the edit history.
 *  - Child DOCUMENTS do NOT roll into the ORDER panel. A cert, a shipment and an invoice each
 *    have their own page and their own panel; the order's panel stays the order's.
 *  - Only models actually audited under their own entity appear here. `invoiceLine`,
 *    `surchargeStepCode` and the order's own lines/containers/serials are audited as their
 *    PARENT's before/after diff (SNAPSHOT_INCLUDE), so they are already on the parent's panel and
 *    an entry for them would resolve to zero rows forever.
 *
 * A parent absent from this map has no children: the lookup returns nothing and the read stays
 * the exact match it has always been. That is the case for `cert`, `shipper`, `quote`,
 * `processTemplate`, `processStepCode` and the eleven reference kinds, all of whose children are
 * edited through the parent.
 */
export const AUDIT_CHILDREN = {
  // The parts page: Specs, Inspections, Pricing, Custom fields, Attachments, Process steps.
  // Every one of them was invisible on the part's panel before #153.
  part: [
    { entity: "partSpecification", label: "Specification", paths: [[{ model: "partSpecification", fk: "partId" }]] },
    { entity: "partInspection", label: "Inspection", paths: [[{ model: "partInspection", fk: "partId" }]] },
    { entity: "partPrice", label: "Pricing", paths: [[{ model: "partPrice", fk: "partId" }]] },
    // Child-of-child: a break belongs to ONE priced operation (it was re-parented off Part in
    // Phase 5A), so it reaches the part only THROUGH its price row — and the walk must find it
    // even when that price row has itself been soft-deleted since, or deleting a whole priced
    // operation would erase its breaks' history from the panel along with it.
    {
      entity: "partPriceBreak",
      label: "Pricing break",
      paths: [[{ model: "partPriceBreak", fk: "partPriceId" }, { model: "partPrice", fk: "partId" }]],
    },
    { entity: "partFieldValue", label: "Custom field", paths: [[{ model: "partFieldValue", fk: "partId" }]] },
    { entity: "partAttachment", label: "Attachment", paths: [[{ model: "partAttachment", fk: "partId" }]] },
    // The reason the 200 cap is load-bearing rather than a nicety: SNAPSHOT_INCLUDE carries a
    // revision's WHOLE step tree twice per entry (before + after), and a well-worn part can hold
    // hundreds of revision entries.
    {
      entity: "partProcessRevision",
      label: "Process steps",
      paths: [[{ model: "partProcessRevision", fk: "partId" }]],
    },
  ],
  // The customer page: Addresses, Contacts, Surcharge overrides, Document templates.
  customer: [
    { entity: "customerAddress", label: "Address", paths: [[{ model: "customerAddress", fk: "customerId" }]] },
    { entity: "customerContact", label: "Contact", paths: [[{ model: "customerContact", fk: "customerId" }]] },
    {
      entity: "customerSurcharge",
      label: "Surcharge override",
      paths: [[{ model: "customerSurcharge", fk: "customerId" }]],
    },
    {
      entity: "customerTemplateAssignment",
      label: "Document template",
      paths: [[{ model: "customerTemplateAssignment", fk: "customerId" }]],
    },
  ],
  // The order hub's Attachments section. Its lines/containers/serials/loads/charges are audited
  // as the order's own diff (design spec §4) and are already here.
  order: [
    { entity: "orderAttachment", label: "Attachment", paths: [[{ model: "orderAttachment", fk: "orderId" }]] },
  ],
  // The invoice page. Lines are the invoice's own diff (§5.5); what it cannot otherwise show is
  // the cash and credit applied against it — including, on a CREDIT memo, the applications that
  // SPENT it. Same section, two FKs, one label; see AuditChildSpec.paths.
  invoice: [
    {
      entity: "application",
      label: "Application",
      paths: [
        [{ model: "application", fk: "invoiceId" }],
        [{ model: "application", fk: "creditInvoiceId" }],
      ],
    },
  ],
  // The receipt batch page lists its payments and each payment's applications; both are audited
  // under their own entities, so neither reached the batch's panel.
  receiptBatch: [
    { entity: "payment", label: "Payment", paths: [[{ model: "payment", fk: "batchId" }]] },
    {
      entity: "application",
      label: "Application",
      paths: [[{ model: "application", fk: "paymentId" }, { model: "payment", fk: "batchId" }]],
    },
  ],
  // The surcharge admin page. Its own step-code grid is a replace-grid audited through the
  // surcharge (SNAPSHOT_INCLUDE.surcharge); the per-customer overrides are not.
  surcharge: [
    {
      entity: "customerSurcharge",
      label: "Customer override",
      paths: [[{ model: "customerSurcharge", fk: "surchargeId" }]],
    },
  ],
} as const satisfies Record<string, readonly AuditChildSpec[]>;

/**
 * The child sections of `parentEntity`, or an empty list if it has none.
 *
 * `Object.hasOwn`, not a bare index: `parentEntity` arrives straight off a query string
 * (`/api/admin/audit?entity=…`), and a plain lookup answers `__proto__` and `toString` with
 * inherited junk that is not a spec list — the registry crash this codebase already learned once
 * (settings.ts's prototype guard). Every consumer goes through this function so the guard cannot
 * be forgotten at one call site.
 */
export function auditChildrenOf(parentEntity: string): readonly AuditChildSpec[] {
  const registry: Record<string, readonly AuditChildSpec[]> = AUDIT_CHILDREN;
  return Object.hasOwn(registry, parentEntity) ? registry[parentEntity] : [];
}

/**
 * What HistoryPanel prints beside a row that belongs to a child section — `null` for the parent's
 * own rows (which need no label) and for any entity that is not a registered child of this
 * parent, so an unlabelable row renders plainly rather than under a guessed name.
 */
export function auditChildLabel(parentEntity: string, rowEntity: string): string | null {
  if (rowEntity === parentEntity) return null;
  for (const spec of auditChildrenOf(parentEntity)) {
    if (spec.entity === rowEntity) return spec.label;
  }
  return null;
}
