/**
 * Stored documents — the one archive every printed PDF in this system goes through (traveler,
 * shipping ticket, bill of lading, certification). Extracted from `traveler.ts` (Phase 4 Task 3,
 * design spec §8): with `StoredDocument` widened to three owner columns (Task 2), the three
 * guarantees this project makes about printed paper — permanent, no delete path anywhere; the
 * bytes never reaching the audit layer; and a reprint being byte-exact — belong in ONE place
 * instead of once per document kind.
 *
 * `kind` decides which owner column(s) a row may carry, enforced in the database by
 * `StoredDocument_kind_owner_check`
 * (prisma/migrations/20260804122700_certs_and_shipping/migration.sql). `storeDocument` below maps
 * `DocumentOwner` onto exactly the combination that CHECK allows for each kind, so this module
 * cannot be made to construct an illegal row even before the constraint is reached.
 */
import { Prisma, type DocumentKind } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { auditedCreate } from "./audit";
import { can, type Area, type PermUser } from "./permissions";

/**
 * The area that gates each kind (design spec §9): a traveler behind `orders.view`, a shipping
 * ticket or bill of lading behind `shipping.view`, a certification behind `certs.view`. The one
 * source of truth for that mapping — both `GET /api/documents/[docId]`'s permission gate and
 * `listDocumentsForOrder`'s per-kind filtering (below) read this same map, so the two can never
 * silently drift onto different answers for the same kind. `Record<DocumentKind, Area>`, not
 * `Record<string, Area>`: a fifth kind added to the enum without an entry here is a compile
 * error, not a runtime fail-closed 403 discovered later.
 */
export const AREA_FOR_KIND: Record<DocumentKind, Area> = {
  TRAVELER: "orders", SHIPPER: "shipping", BOL: "shipping", CERT: "certs",
  INVOICE: "invoicing", CREDIT: "invoicing", STATEMENT: "receivables", QUOTE: "quotes",
};

/**
 * What a document belongs to, and how it was printed.
 *
 * `orderId` on a `SHIPPER` document is a SUB-scope, not an alternate owner — exactly the double
 * duty `loadNumber` already does for a `TRAVELER`: which one order's ticket this is, with `null`
 * meaning the whole shipment's set. That asymmetry is the design (spec §4.3), not something to
 * "tighten" toward `shipperId`-only.
 */
export type DocumentOwner =
  | { kind: "TRAVELER"; orderId: string; loadNumber: number | null }
  | { kind: "SHIPPER"; shipperId: string; orderId: string | null }
  | { kind: "BOL"; shipperId: string }
  | { kind: "CERT"; certId: string }
  | { kind: "INVOICE"; invoiceId: string }
  | { kind: "CREDIT"; invoiceId: string }
  | { kind: "STATEMENT"; customerId: string }
  | { kind: "QUOTE"; quoteId: string };

export type DocumentMeta = {
  id: string; kind: DocumentKind; createdAt: Date;
  orderId: string | null; shipperId: string | null; certId: string | null; invoiceId: string | null;
  customerId: string | null; quoteId: string | null;
  loadNumber: number | null;
};

/** Every scalar column except `fileData` — a list of documents has no reason to pull N PDFs into
 *  memory to render a timestamp. `getDocument` adds `fileData` back on top of this same shape
 *  rather than keeping a second column list that could drift from this one. */
const DOCUMENT_SELECT = {
  id: true, kind: true, createdAt: true,
  orderId: true, shipperId: true, certId: true, invoiceId: true, customerId: true, quoteId: true,
  loadNumber: true,
} satisfies Prisma.StoredDocumentSelect;

/** `DocumentOwner` → the four owner/scope columns `storedDocument.create` needs, matching the DB
 *  CHECK constraint kind-for-kind. Kept as one small mapping so the CHECK's shape and this
 *  module's shape can never silently drift apart. */
function ownerColumns(owner: DocumentOwner): {
  kind: DocumentKind;
  orderId: string | null; shipperId: string | null; certId: string | null; invoiceId: string | null;
  customerId: string | null; quoteId: string | null;
  loadNumber: number | null;
} {
  const none = {
    orderId: null, shipperId: null, certId: null, invoiceId: null, customerId: null, quoteId: null,
    loadNumber: null,
  };
  switch (owner.kind) {
    case "TRAVELER":
      return { ...none, kind: "TRAVELER", orderId: owner.orderId, loadNumber: owner.loadNumber };
    case "SHIPPER":
      return { ...none, kind: "SHIPPER", orderId: owner.orderId, shipperId: owner.shipperId };
    case "BOL":
      return { ...none, kind: "BOL", shipperId: owner.shipperId };
    case "CERT":
      return { ...none, kind: "CERT", certId: owner.certId };
    case "INVOICE":
      return { ...none, kind: "INVOICE", invoiceId: owner.invoiceId };
    case "CREDIT":
      return { ...none, kind: "CREDIT", invoiceId: owner.invoiceId };
    case "STATEMENT":
      return { ...none, kind: "STATEMENT", customerId: owner.customerId };
    case "QUOTE":
      return { ...none, kind: "QUOTE", quoteId: owner.quoteId };
  }
}

/**
 * Shared refusal for every print guard in this codebase (Task 10; consumed here by
 * `printTraveler`, and by Tasks 18/19 for the shipping ticket/BOL and certification prints):
 * spec §5.6's "stored PDFs survive a void forever and stay reprintable; new prints are refused"
 * is Phase 3's voided-order rule (traveler.ts's own original `VOIDED` constant) reused, not
 * reinvented, for every document owner this phase adds.
 */
export const VOIDED_PRINT = "This record is voided — no new documents can be produced for it";

/**
 * Throws 400 `VOIDED_PRINT` when `owner.deletedAt` is set. Call inside the transaction that
 * already claimed `owner`'s row (`claimOrder`, and the shipper/cert claims later tasks add) —
 * never a fresh, unlocked read of its own: the caller's own claim is what makes the check
 * race-free (order-locks.ts's own reasoning), this function only reads the field off what the
 * caller already resolved under that lock.
 */
export function assertPrintable(owner: { deletedAt: Date | null }): void {
  if (owner.deletedAt !== null) throw new HttpError(400, VOIDED_PRINT);
}

/**
 * Archives one rendered PDF, permanently — there is no delete path for a `StoredDocument`
 * anywhere in this codebase (design spec §4: "no delete path at all"), and this is the only place
 * a row is ever created.
 *
 * Metadata only in the audit payload — the bytes are never handed to the audit layer (CLAUDE.md:
 * `redact()` is defense in depth, not the mechanism that keeps them out). `new Uint8Array(pdf)`,
 * not the Buffer itself: Prisma's `Bytes` input is typed `Uint8Array<ArrayBuffer>`, and Node's
 * `Buffer` is `Uint8Array<ArrayBufferLike>`, which that does not accept (the `printTraveler`
 * precedent this was extracted from).
 *
 * `tx` is required, never optional (CLAUDE.md; audit.ts's own `Db` comment): every caller is
 * expected to already be holding a row claim on the entity it is archiving against — `claimOrder`
 * for a traveler, and the shipper/cert equivalents later tasks add — for the same reason
 * `printTraveler` always did: the render has to describe a state that cannot change out from
 * under it between the read and the archive.
 */
export async function storeDocument(
  tx: Prisma.TransactionClient, owner: DocumentOwner, pdf: Buffer,
): Promise<DocumentMeta> {
  const data = ownerColumns(owner);
  return auditedCreate("storedDocument", data,
    () => tx.storedDocument.create({ data: { ...data, fileData: new Uint8Array(pdf) }, select: DOCUMENT_SELECT }),
    { tx });
}

/**
 * Every document that pertains to this order, newest first — including a multi-order shipment's
 * BOL and a shipment-scope cert, neither of which carries this order's id as its own `orderId`
 * (a BOL never sets `orderId` at all — see the CHECK). The union (design spec §8) is what puts
 * that BOL on every order it covers, not merely the one that happens to be the row's `orderId`.
 * `createdAt` ties break on `id`, a time-ordered cuid, so two prints inside the same millisecond
 * still list in the order they happened.
 *
 * Never filters on any owner's `deletedAt`: a voided order/shipper/cert keeps every earlier print
 * listable and reprintable forever (spec §5.6).
 *
 * `viewer`, when given, drops any kind the caller may not view — the owner's ruling (2026-08-04,
 * Task 3 review round 2): listing an order's documents must not disclose that a shipment's BOL or
 * a certification exists to someone who cannot open it. Filtered per kind against `AREA_FOR_KIND`,
 * the same shape `globalSearch` (search.ts) already uses for its own permission-filtered groups —
 * a kind the caller cannot view is silently dropped from the array, never a 403 for the whole
 * call: the caller asked to list an ORDER's documents, and is entitled to that, just not to every
 * kind of document filed against it.
 *
 * `viewer` is OPTIONAL: this function has trusted, non-request callers too (this file's
 * `listDocuments` alias is called directly and unfiltered throughout tests/traveler.test.ts, which
 * is testing print/archive plumbing, not authorization), and omitting `viewer` there keeps every
 * kind visible exactly as before. `src/app/api/orders/[id]/documents/route.ts` — the one place
 * this reaches an actual HTTP caller — is the one call site that MUST always pass it.
 */
export async function listDocumentsForOrder(orderId: string, viewer?: PermUser): Promise<DocumentMeta[]> {
  const order = await prisma.order.findFirst({ where: { id: orderId }, select: { id: true } });
  if (!order) throw new HttpError(404, "Order not found");

  const allowedKinds = (Object.keys(AREA_FOR_KIND) as DocumentKind[])
    .filter((kind) => viewer === undefined || can(viewer, AREA_FOR_KIND[kind], "view"));
  if (allowedKinds.length === 0) return [];

  return prisma.storedDocument.findMany({
    where: {
      kind: { in: allowedKinds },
      OR: [
        { orderId },
        { cert: { orderId } },
        // An INVOICE/CREDIT carries only its own `invoiceId`, never the order's id directly (the
        // kind→owner CHECK), so the invoice appears on its order's hub through this join, the same
        // shape the cert branch above uses (P5A spec §10).
        { invoice: { orderId } },
        // Whole-shipment paper only (`orderId: null` — the BOL, a whole-set ticket): a SIBLING
        // order's own ticket also matches the bare relation (its shipperId is this shipment's),
        // and it is not this order's paper (round-4 finding).
        { orderId: null, shipper: { orders: { some: { orderId } } } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: DOCUMENT_SELECT,
  });
}

/** Every `SHIPPER` and `BOL` document filed against this shipment — both own `shipperId` directly,
 *  so no union is needed the way `listDocumentsForOrder` needs one. */
export async function listDocumentsForShipper(shipperId: string): Promise<DocumentMeta[]> {
  const shipper = await prisma.shipper.findFirst({ where: { id: shipperId }, select: { id: true } });
  if (!shipper) throw new HttpError(404, "Shipper not found");
  return prisma.storedDocument.findMany({
    where: { shipperId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: DOCUMENT_SELECT,
  });
}

/** Every `CERT` document filed against this certification. */
export async function listDocumentsForCert(certId: string): Promise<DocumentMeta[]> {
  const cert = await prisma.cert.findFirst({ where: { id: certId }, select: { id: true } });
  if (!cert) throw new HttpError(404, "Cert not found");
  return prisma.storedDocument.findMany({
    where: { certId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: DOCUMENT_SELECT,
  });
}

/** Every `INVOICE`/`CREDIT` document filed against THIS invoice row — a credit's own printed PDF
 *  carries the CREDIT's own id in `invoiceId`, never its source invoice's (`storeDocument`'s
 *  `INVOICE`/`CREDIT` branches both write `invoiceId` to the row being printed), so no union is
 *  needed here either, the same shape as `listDocumentsForShipper`/`listDocumentsForCert` above. */
export async function listDocumentsForInvoice(invoiceId: string): Promise<DocumentMeta[]> {
  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId }, select: { id: true } });
  if (!invoice) throw new HttpError(404, "Invoice not found");
  return prisma.storedDocument.findMany({
    where: { invoiceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: DOCUMENT_SELECT,
  });
}

/** Every `STATEMENT` document filed against this customer (Task 15, P5B §11's customer A/R
 *  section and the `/receivables/statements` screen's own document history) — `customerId` is a
 *  column only `STATEMENT` ever populates (`ownerColumns` above), so this needs no kind filter the
 *  way `listDocumentsForShipper`'s BOL/SHIPPER pair does not either. */
export async function listDocumentsForCustomer(customerId: string): Promise<DocumentMeta[]> {
  // No `deletedAt: null` filter — the `listDocumentsForOrder`/`listDocumentsForShipper`/
  // `listDocumentsForCert` precedent: a deleted customer's past statements stay listable forever,
  // the same "voided owner, still-reprintable paper" rule spec §5.6 states for every other kind.
  const customer = await prisma.customer.findFirst({ where: { id: customerId }, select: { id: true } });
  if (!customer) throw new HttpError(404, "Customer not found");
  return prisma.storedDocument.findMany({
    where: { customerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: DOCUMENT_SELECT,
  });
}

/** Every `QUOTE` document filed against this quote (Phase 6 spec §6 — the quote page's print
 *  history) — `quoteId` is a column only `QUOTE` ever populates (`ownerColumns` above), so no
 *  kind filter or union is needed, the `listDocumentsForInvoice`/`listDocumentsForCert` shape
 *  exactly. No `deletedAt` filter on the quote: a deleted quote's past prints stay listable and
 *  reprintable forever (spec §5.6's voided-owner rule, same as every kind above). */
export async function listDocumentsForQuote(quoteId: string): Promise<DocumentMeta[]> {
  const quote = await prisma.quote.findFirst({ where: { id: quoteId }, select: { id: true } });
  if (!quote) throw new HttpError(404, "Quote not found");
  return prisma.storedDocument.findMany({
    where: { quoteId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: DOCUMENT_SELECT,
  });
}

/** The stored bytes, untouched — a reprint is a byte-for-byte reissue of what was printed, never
 *  a re-render (the source data behind any of the four kinds can keep changing after a print).
 *  Never filters on `deletedAt` either, for the same reason `listDocumentsFor*` above does not. */
export async function getDocument(docId: string): Promise<DocumentMeta & { fileData: Buffer }> {
  const row = await prisma.storedDocument.findUnique({
    where: { id: docId }, select: { ...DOCUMENT_SELECT, fileData: true },
  });
  if (!row) throw new HttpError(404, "Document not found");
  const { fileData, ...meta } = row;
  // Prisma's `Bytes` scalar is a bare Uint8Array; Buffer.from guarantees the real Node Buffer
  // this signature promises (the attachments service precedent).
  return { ...meta, fileData: Buffer.from(fileData) };
}

/**
 * `traveler-71246.pdf`, `traveler-71246-load-3.pdf`, `ticket-72826.pdf`, `bol-72826.pdf`,
 * `cert-72036.pdf` — what the browser tab and any save-as dialog show. A cert has no number of
 * its own (spec §3.19), so its friendly name is its owning order's number instead — the same
 * number spec §10.3's cert layout itself prints under "Order No.".
 *
 * `orderNumber`/`shipperNumber` are the CALLER's to supply, exactly as `printTraveler` already
 * carried `orderNumber` alongside (never inside) its document metadata: this function itself
 * performs no lookups. A caller that already has a friendly number on hand (it just created or
 * looked up the order/shipment) passes it through; one that doesn't falls back to the raw id —
 * still a unique, safe filename, just not a pretty one. `resolveDocumentFilename` below is the
 * one caller that doesn't already have one and fetches it first.
 */
export function documentFilename(
  meta: DocumentMeta, orderNumber?: number, shipperNumber?: number, creditNumber?: number,
  customerCode?: string, quoteNumber?: number,
): string {
  switch (meta.kind) {
    case "TRAVELER": {
      const order = orderNumber ?? meta.orderId;
      return meta.loadNumber === null ? `traveler-${order}.pdf` : `traveler-${order}-load-${meta.loadNumber}.pdf`;
    }
    case "SHIPPER": {
      const ship = shipperNumber ?? meta.shipperId;
      return meta.orderId === null ? `ticket-${ship}.pdf` : `ticket-${ship}-order-${orderNumber ?? meta.orderId}.pdf`;
    }
    case "BOL":
      return `bol-${shipperNumber ?? meta.shipperId}.pdf`;
    case "CERT":
      return `cert-${orderNumber ?? meta.certId}.pdf`;
    // An invoice is named by the order it bills; a credit carries a number of its own
    // (P5A design spec §10). `creditNumber` is the CALLER's to supply, exactly as
    // `orderNumber`/`shipperNumber` already are — this function performs no lookups.
    case "INVOICE":
      return `invoice-${orderNumber ?? meta.invoiceId}.pdf`;
    case "CREDIT":
      return `credit-${creditNumber ?? meta.invoiceId}.pdf`;
    // A statement is owned by a customer (Phase 5B §8) and named by that customer's code, the
    // caller's to supply (falling back to the raw id) exactly as the numbers above are.
    case "STATEMENT":
      return `statement-${customerCode ?? meta.customerId}.pdf`;
    // A quote is named by its own quote number (Phase 6 §6), the caller's to supply — falling
    // back to the raw id exactly as every kind above does.
    case "QUOTE":
      return `quote-${quoteNumber ?? meta.quoteId}.pdf`;
  }
}

/**
 * `documentFilename`, but for the one caller that does NOT already have a friendly number on
 * hand: the download route (`src/app/api/documents/[docId]/route.ts`). Every other consumer of
 * this module already knows its own order/shipper (`printTraveler` does) and calls
 * `documentFilename` directly rather than pay for a lookup nothing else needs.
 *
 * Regression note (Task 3 review round 2): the pre-extraction `traveler.ts` joined
 * `order: { select: { orderNumber: true } }` into its own document-select query specifically so
 * the download route could name the file `traveler-71246.pdf` rather than a raw cuid. The initial
 * extraction dropped that join without adding a substitute at the one call site that needed it,
 * so every downloaded filename regressed to `traveler-<cuid>.pdf`. This function is that
 * substitute, generalized to all four kinds — one extra, targeted read per download, never one
 * per list entry.
 */
export async function resolveDocumentFilename(meta: DocumentMeta): Promise<string> {
  switch (meta.kind) {
    case "TRAVELER": {
      const order = meta.orderId === null ? null
        : await prisma.order.findFirst({ where: { id: meta.orderId }, select: { orderNumber: true } });
      return documentFilename(meta, order?.orderNumber);
    }
    case "SHIPPER": {
      const [shipper, order] = await Promise.all([
        meta.shipperId === null ? null
          : prisma.shipper.findFirst({ where: { id: meta.shipperId }, select: { shipperNumber: true } }),
        meta.orderId === null ? null
          : prisma.order.findFirst({ where: { id: meta.orderId }, select: { orderNumber: true } }),
      ]);
      return documentFilename(meta, order?.orderNumber, shipper?.shipperNumber);
    }
    case "BOL": {
      const shipper = meta.shipperId === null ? null
        : await prisma.shipper.findFirst({ where: { id: meta.shipperId }, select: { shipperNumber: true } });
      return documentFilename(meta, undefined, shipper?.shipperNumber);
    }
    case "CERT": {
      const cert = meta.certId === null ? null
        : await prisma.cert.findFirst({ where: { id: meta.certId }, select: { orderId: true } });
      const order = cert === null ? null
        : await prisma.order.findFirst({ where: { id: cert.orderId }, select: { orderNumber: true } });
      return documentFilename(meta, order?.orderNumber);
    }
    case "INVOICE":
    case "CREDIT": {
      const invoice = meta.invoiceId === null ? null
        : await prisma.invoice.findFirst({
            where: { id: meta.invoiceId },
            select: { creditNumber: true, order: { select: { orderNumber: true } } },
          });
      return documentFilename(meta, invoice?.order.orderNumber, undefined, invoice?.creditNumber ?? undefined);
    }
    case "STATEMENT": {
      const customer = meta.customerId === null ? null
        : await prisma.customer.findFirst({ where: { id: meta.customerId }, select: { code: true } });
      return documentFilename(meta, undefined, undefined, undefined, customer?.code);
    }
    case "QUOTE": {
      const quote = meta.quoteId === null ? null
        : await prisma.quote.findFirst({ where: { id: meta.quoteId }, select: { quoteNumber: true } });
      return documentFilename(meta, undefined, undefined, undefined, undefined, quote?.quoteNumber);
    }
  }
}
