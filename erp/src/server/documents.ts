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
  | { kind: "CERT"; certId: string };

export type DocumentMeta = {
  id: string; kind: DocumentKind; createdAt: Date;
  orderId: string | null; shipperId: string | null; certId: string | null; loadNumber: number | null;
};

/** Every scalar column except `fileData` — a list of documents has no reason to pull N PDFs into
 *  memory to render a timestamp. `getDocument` adds `fileData` back on top of this same shape
 *  rather than keeping a second column list that could drift from this one. */
const DOCUMENT_SELECT = {
  id: true, kind: true, createdAt: true,
  orderId: true, shipperId: true, certId: true, loadNumber: true,
} satisfies Prisma.StoredDocumentSelect;

/** `DocumentOwner` → the four owner/scope columns `storedDocument.create` needs, matching the DB
 *  CHECK constraint kind-for-kind. Kept as one small mapping so the CHECK's shape and this
 *  module's shape can never silently drift apart. */
function ownerColumns(owner: DocumentOwner): {
  kind: DocumentKind;
  orderId: string | null; shipperId: string | null; certId: string | null; loadNumber: number | null;
} {
  switch (owner.kind) {
    case "TRAVELER":
      return { kind: "TRAVELER", orderId: owner.orderId, shipperId: null, certId: null, loadNumber: owner.loadNumber };
    case "SHIPPER":
      return { kind: "SHIPPER", orderId: owner.orderId, shipperId: owner.shipperId, certId: null, loadNumber: null };
    case "BOL":
      return { kind: "BOL", orderId: null, shipperId: owner.shipperId, certId: null, loadNumber: null };
    case "CERT":
      return { kind: "CERT", orderId: null, shipperId: null, certId: owner.certId, loadNumber: null };
  }
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
 */
export async function listDocumentsForOrder(orderId: string): Promise<DocumentMeta[]> {
  const order = await prisma.order.findFirst({ where: { id: orderId }, select: { id: true } });
  if (!order) throw new HttpError(404, "Order not found");
  return prisma.storedDocument.findMany({
    where: { OR: [
      { orderId },
      { cert: { orderId } },
      { shipper: { orders: { some: { orderId } } } },
    ] },
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
 * `cert-<id>.pdf` — what the browser tab and any save-as dialog show.
 *
 * `orderNumber`/`shipperNumber` are the CALLER's to supply, exactly as `printTraveler` already
 * carried `orderNumber` alongside (never inside) its document metadata: this module never joins
 * to another table just to learn a friendly number for a filename. A caller that already has one
 * on hand (it just created or looked up the order/shipment) passes it through; one that doesn't
 * falls back to the raw id — still a unique, safe filename, just not a pretty one.
 */
export function documentFilename(meta: DocumentMeta, orderNumber?: number, shipperNumber?: number): string {
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
      return `cert-${meta.certId}.pdf`;
  }
}
