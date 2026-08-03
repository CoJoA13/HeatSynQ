import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedSoftDelete } from "./audit";

export type AttachmentOwner = "part" | "order";
export type AttachmentMeta = { id: string; filename: string; mimeType: string; size: number; createdAt: Date };

// 20 MB (task-11-brief.md) — the byte-length cap on any one uploaded file.
const MAX_SIZE = 20 * 1024 * 1024;

// image/* and PDF render usefully in a browser tab; everything else on the allowlist is a
// download-only format. This is also what decides Content-Disposition (contentDisposition below).
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
const ALLOWED_TYPES = new Set<string>([
  ...INLINE_TYPES,
  "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
]);

/** Strips control characters (CR/LF header-injection defense) and escapes backslash/quote for the
 *  quoted-string form (RFC 6266 / RFC 2616 §2.2). `filename` is whatever the browser sent as the
 *  original upload name and lands verbatim in a raw response header otherwise. */
function escapeDispositionFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/** `Content-Disposition` value for a GET-bytes response: `inline` for anything a browser tab can
 *  render on its own (images, PDF), `attachment` (forces a download) for everything else on the
 *  allowlist (csv/plain text/office docs) — shared by both owners' byte-serving routes so the
 *  inline/attachment split and the filename escaping live in exactly one place. */
export function contentDisposition(mimeType: string, filename: string): string {
  const kind = INLINE_TYPES.has(mimeType) ? "inline" : "attachment";
  return `${kind}; filename="${escapeDispositionFilename(filename)}"`;
}

type Db = typeof prisma | Prisma.TransactionClient;

const OWNER_LABEL: Record<AttachmentOwner, string> = { part: "Part", order: "Order" };
const OWNER_COLUMN: Record<AttachmentOwner, "partId" | "orderId"> = { part: "partId", order: "orderId" };
const AUDIT_MODEL: Record<AttachmentOwner, "partAttachment" | "orderAttachment"> =
  { part: "partAttachment", order: "orderAttachment" };

/** `{ partId: ownerId }` or `{ orderId: ownerId }` — isolated behind one helper (annotated
 *  `Record<string, string>`) so the computed key never has to satisfy either delegate's stricter,
 *  owner-specific `where`/`data` input type at the call site. */
function ownerFilter(owner: AttachmentOwner, ownerId: string): Record<string, string> {
  return { [OWNER_COLUMN[owner]]: ownerId };
}

/**
 * `findFirst({ id, deletedAt: null })` on the owner model, per owner kind (brief: "owner row must
 * be live (404 otherwise)"). Applied uniformly below to every exported function, reads included.
 *
 * This deliberately does NOT mirror orders.ts's `readDetail`, which skips the `deletedAt` filter
 * because a voided order stays readable (spec §5c) — nor `deletePart`'s cascade, which soft-deletes
 * a part's specifications/inspections/price breaks alongside it, so those children's own `list`
 * queries (filtered on their OWN `deletedAt`) already read empty without needing an owner check.
 * Attachments get neither a cascade from `deletePart`/`voidOrder` nor an exemption from this
 * check, so this guard is what keeps a dead owner's files from staying visible/downloadable
 * forever. One uniform rule for both owners, per the brief's own unqualified wording — not a
 * copy-paste of either existing precedent.
 */
async function assertOwnerLive(owner: AttachmentOwner, ownerId: string, db: Db): Promise<void> {
  const live = owner === "part"
    ? await db.part.findFirst({ where: { id: ownerId, deletedAt: null }, select: { id: true } })
    : await db.order.findFirst({ where: { id: ownerId, deletedAt: null }, select: { id: true } });
  if (!live) throw new HttpError(404, `${OWNER_LABEL[owner]} not found`);
}

type AttachmentListRow = { id: string; filename: string; mimeType: string; size: number; createdAt: Date };
type AttachmentFullRow = AttachmentListRow & { fileData: Uint8Array };

// Every owner kind is a Prisma delegate over an identically-shaped table (schema.prisma:
// PartAttachment/OrderAttachment differ only in their owner FK column name) — the reference.ts
// kind-registry pattern (assertKind/delegate there), with exactly two kinds instead of ten.
type AttachmentDelegate = {
  findMany: (a: { where: object; orderBy?: object; select?: object }) => Promise<AttachmentListRow[]>;
  findFirst: (a: { where: object }) => Promise<AttachmentFullRow | null>;
  create: (a: { data: object }) => Promise<AttachmentFullRow>;
};
function delegate(owner: AttachmentOwner, db: Db = prisma): AttachmentDelegate {
  return (owner === "part" ? db.partAttachment : db.orderAttachment) as unknown as AttachmentDelegate;
}

export async function listAttachments(owner: AttachmentOwner, ownerId: string): Promise<AttachmentMeta[]> {
  await assertOwnerLive(owner, ownerId, prisma);
  // fileData excluded via `select` — a list of N attachments has no reason to pull N files'
  // worth of bytes into memory just to render a filename/size/date row.
  return delegate(owner).findMany({
    where: { ...ownerFilter(owner, ownerId), deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, filename: true, mimeType: true, size: true, createdAt: true },
  });
}

export async function getAttachment(
  owner: AttachmentOwner, ownerId: string, attId: string,
): Promise<AttachmentMeta & { fileData: Buffer }> {
  await assertOwnerLive(owner, ownerId, prisma);
  // Scoped to `ownerId` in the same `where` as the id lookup — this is what makes cross-owner
  // access (an order id paired with a part attachment's id, or vice versa) 404 rather than leak:
  // the two owner kinds are different Prisma models entirely, so an id from one table simply
  // never matches a row scoped under the other table's owner column.
  const row = await delegate(owner).findFirst({
    where: { id: attId, ...ownerFilter(owner, ownerId), deletedAt: null },
  });
  if (!row) throw new HttpError(404, "Attachment not found");
  return {
    id: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size, createdAt: row.createdAt,
    // Prisma's `Bytes` scalar is typed as a bare `Uint8Array` (node_modules/@prisma/client's own
    // `runtime.Bytes` alias) — `Buffer.from` guarantees the real Node `Buffer` this function's
    // return type promises regardless of exactly which Uint8Array subtype the client handed back.
    fileData: Buffer.from(row.fileData),
  };
}

export async function addAttachment(
  owner: AttachmentOwner, ownerId: string,
  file: { filename: string; mimeType: string; data: Buffer },
): Promise<AttachmentMeta> {
  if (!ALLOWED_TYPES.has(file.mimeType)) throw new HttpError(400, "That file type is not allowed");
  if (file.data.byteLength > MAX_SIZE) throw new HttpError(400, "Attachments cannot exceed 20 MB");

  const row = await withDbErrors({ entity: OWNER_LABEL[owner] }, () =>
    prisma.$transaction(async (tx) => {
      await assertOwnerLive(owner, ownerId, tx);
      const meta = { filename: file.filename, mimeType: file.mimeType, size: file.data.byteLength };
      const data = { ...ownerFilter(owner, ownerId), ...meta, fileData: file.data };
      // Audit payload is metadata only — fileData is never handed to the audit layer for a
      // create (CLAUDE.md: redact() is defense in depth, not the mechanism that's supposed to
      // keep bytes out in the first place). The soft-delete path below can't make the same
      // promise: auditedSoftDelete's own "before" snapshot is a bare findUnique with no column
      // projection, so THAT path leans on redact()'s "filedata" pattern (Task 1) instead.
      const auditPayload = { ...ownerFilter(owner, ownerId), ...meta };
      return auditedCreate(AUDIT_MODEL[owner], auditPayload, () => delegate(owner, tx).create({ data }), { tx });
    }));
  return { id: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size, createdAt: row.createdAt };
}

export async function deleteAttachment(owner: AttachmentOwner, ownerId: string, attId: string): Promise<void> {
  await assertOwnerLive(owner, ownerId, prisma);
  const current = await delegate(owner).findFirst({
    where: { id: attId, ...ownerFilter(owner, ownerId), deletedAt: null },
  });
  if (!current) throw new HttpError(404, "Attachment not found");
  await withDbErrors({ entity: OWNER_LABEL[owner] }, () =>
    prisma.$transaction((tx) => auditedSoftDelete(AUDIT_MODEL[owner], attId, undefined, tx)));
}
