import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedSoftDelete } from "./audit";
import { claimOrder } from "./orders";

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

/** Strips control characters (CR/LF header-injection defense) — shared by both the quoted-string
 *  and RFC 5987 forms below, neither of which is safe to build from a raw, unfiltered upload
 *  name. `filename` is whatever the browser sent as the original upload name. */
function stripControlChars(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, "");
}

/** Escapes backslash/quote for the quoted-string form (RFC 6266 / RFC 2616 §2.2). */
function escapeQuoted(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/**
 * ASCII-only approximation of `name` for the legacy `filename=` parameter: every codepoint
 * outside printable ASCII (0x20-0x7e) becomes "_". Fix-wave finding 7: a raw non-ASCII codepoint
 * here is not a quoting problem `escapeQuoted` can fix — `Headers`/`NextResponse` require header
 * values to be Latin1/ByteString, and constructing the response for an attachment named e.g.
 * "測定.pdf" threw outright, so the file could be uploaded but never downloaded again.
 * `rfc5987Encode` below carries the real name for every current browser, which all read it in
 * preference to this one; this is only the fallback for a client that understands neither.
 */
function asciiFallback(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_");
}

/**
 * RFC 5987 `ext-value` percent-encoding for the `filename*=UTF-8''...` parameter.
 * `encodeURIComponent` already escapes everything the grammar's `attr-char` set excludes except
 * `* ' ( )` (which it deliberately leaves literal, since all four are legal inside a URI
 * component) — those four are escaped by hand on top so the result is valid `attr-char`-only
 * percent-encoding. Also collapses any CR/LF that survived as raw bytes into their own %-encoded
 * form, so this half of the header is immune to header injection independent of the stripping
 * `contentDisposition` already does up front.
 */
function rfc5987Encode(name: string): string {
  return encodeURIComponent(name).replace(/[*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `Content-Disposition` value for a GET-bytes response: `inline` for anything a browser tab can
 * render on its own (images, PDF), `attachment` (forces a download) for everything else on the
 * allowlist (csv/plain text/office docs) — shared by both owners' byte-serving routes so the
 * inline/attachment split and the filename encoding live in exactly one place. Carries BOTH an
 * ASCII-sanitized `filename=` fallback and the faithful RFC 5987 `filename*=UTF-8''...` form
 * (RFC 6266 §4.3's own recommendation, sent unconditionally rather than only when the name
 * happens to need it — one code path, not an ASCII/non-ASCII fork) — every current browser reads
 * the latter, so an attachment named e.g. "測定.pdf" still downloads under its real name; only a
 * client that understands neither parameter would ever see the sanitized fallback.
 */
export function contentDisposition(mimeType: string, filename: string): string {
  const kind = INLINE_TYPES.has(mimeType) ? "inline" : "attachment";
  const stripped = stripControlChars(filename);
  const quoted = escapeQuoted(asciiFallback(stripped));
  const encoded = rfc5987Encode(stripped);
  return `${kind}; filename="${quoted}"; filename*=UTF-8''${encoded}`;
}

/**
 * Fix-wave R4 finding 2: both attachment MUTATORS run Serializable, for BOTH owners.
 *
 * The in-transaction owner check (`assertOwnerVisible` below) was only ever half of a guard. Its
 * other half is the deleting side's own scan, and `deletePart` (parts.ts) does that scan
 * Serializable precisely so a child added mid-delete cannot outlive its parent — the F2 pairing
 * `addPartSpec`/`addPartInspection`/`addPartBreak` already hold up from their end. Attachments
 * joined the delete cascade (R3 finding 5) without joining that pairing: at the default isolation
 * a disjoint `INSERT INTO "PartAttachment"` conflicts with nothing `deletePart` does, so the
 * cascade could snapshot the live attachments, soft-delete exactly those, and commit, while a
 * concurrent upload — whose owner check legitimately saw a live part on its own older snapshot —
 * inserted bytes that ended up LIVE under a part that is now deleted: permanently unreachable
 * behind every guard here, and absent from the parent's own history. Both sides Serializable is
 * what lets Postgres abort whichever one would produce a state no serial ordering could.
 *
 * Applied uniformly rather than part-only. The order owner already serializes through
 * `claimOrder`'s row lock, so this is belt-and-braces there — but a per-owner isolation split
 * would be one more thing to remember correctly at every future call site, and `withDbErrors`
 * already maps the resulting 40001/P2034 to the retryable 409 on both paths.
 */
const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

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

type OwnerAccessMode = "read" | "write";

/**
 * Whether `assertOwnerVisible` (below) requires `deletedAt: null`, per owner kind × access mode.
 * The one asymmetry: an order stays readable once voided — orders.ts's `readDetail` deliberately
 * skips the same filter for the same reason ("a voided order is still readable", spec §5c) — while
 * a part has no equivalent "gone but still visible" state (`getPart` 404s a deleted part outright).
 * Mutations on EITHER owner stay live-only regardless: mirrors every order-child mutator in
 * orders.ts (addLine/updateLine/removeLine/replaceContainers/etc., all of which re-check
 * `deletedAt: null` before writing — spec §5a, "a wrong-part order is voided and re-keyed, not
 * patched") and every part-child mutator (assertPartLive precedent, part-specifications.ts et al).
 *
 * Adjudicated in Task 11 fix round 1: review flagged this exact read/write, part/order asymmetry;
 * the owner confirmed order READS follow `readDetail`'s exemption, order WRITES and every part
 * path stay live-only.
 */
const REQUIRES_LIVE: Record<AttachmentOwner, Record<OwnerAccessMode, boolean>> = {
  part: { read: true, write: true },
  order: { read: false, write: true },
};

async function assertOwnerVisible(
  owner: AttachmentOwner, ownerId: string, mode: OwnerAccessMode, db: Db,
): Promise<void> {
  // Fix-wave R3 finding 1: an order-owned WRITE (addAttachment/deleteAttachment) claims the Order
  // row through the SAME `claimOrder` (orders.ts) every other order-family mutator now opens
  // with, instead of the plain, unlocked check below — so an attachment add/delete can no longer
  // commit invisibly while a traveler print is mid-render (traveler.ts's own claim on this same
  // row). Reads (`listAttachments`/`getAttachment`) stay on the unlocked check: `REQUIRES_LIVE`
  // already keeps order reads live-agnostic (a voided order stays readable, spec §5c), and a pure
  // read has nothing to serialize against — only a WRITE can be the thing racing a render. `db`
  // is always the caller's own `tx` in write mode (both call sites below pass it), never the
  // top-level client, so this claim always lands inside the SAME transaction as the write itself.
  if (owner === "order" && mode === "write") {
    const claimed = await claimOrder(db, ownerId);
    if (!claimed || claimed.deletedAt !== null) throw new HttpError(404, `${OWNER_LABEL.order} not found`);
    return;
  }

  const mustBeLive = REQUIRES_LIVE[owner][mode];
  const live = owner === "part"
    ? await db.part.findFirst({
      where: mustBeLive ? { id: ownerId, deletedAt: null } : { id: ownerId }, select: { id: true },
    })
    : await db.order.findFirst({
      where: mustBeLive ? { id: ownerId, deletedAt: null } : { id: ownerId }, select: { id: true },
    });
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
  await assertOwnerVisible(owner, ownerId, "read", prisma);
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
  await assertOwnerVisible(owner, ownerId, "read", prisma);
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
      await assertOwnerVisible(owner, ownerId, "write", tx);
      const meta = { filename: file.filename, mimeType: file.mimeType, size: file.data.byteLength };
      const data = { ...ownerFilter(owner, ownerId), ...meta, fileData: file.data };
      // Audit payload is metadata only — fileData is never handed to the audit layer for a
      // create (CLAUDE.md: redact() is defense in depth, not the mechanism that's supposed to
      // keep bytes out in the first place). The soft-delete path below makes the same promise a
      // different way: auditedSoftDelete's own "before" snapshot now runs through audit.ts's
      // SNAPSHOT_SELECT for this model (fix-wave finding 3), which excludes fileData at the query
      // itself rather than leaning on redact()'s "filedata" pattern to scrub it afterward.
      const auditPayload = { ...ownerFilter(owner, ownerId), ...meta };
      return auditedCreate(AUDIT_MODEL[owner], auditPayload, () => delegate(owner, tx).create({ data }), { tx });
    }, SERIALIZABLE));
  return { id: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size, createdAt: row.createdAt };
}

/**
 * Fix-wave finding 11: the owner-liveness check and the attachment's own existence check now run
 * on THIS transaction's own `tx` — the addAttachment "house mutator shape" above already uses —
 * rather than as two standalone statements on the top-level `prisma` client before this
 * transaction even opened. Before this, a concurrent void/delete of the owner landing in that gap
 * would commit unnoticed: nothing about auditedSoftDelete's own atomic updateMany re-checks the
 * OWNER's liveness, only the attachment row's own. Moving both onto `tx` narrows that window to
 * "however long this one transaction takes" instead of "however long between two independent
 * round trips".
 */
export async function deleteAttachment(owner: AttachmentOwner, ownerId: string, attId: string): Promise<void> {
  await withDbErrors({ entity: OWNER_LABEL[owner] }, () =>
    prisma.$transaction(async (tx) => {
      await assertOwnerVisible(owner, ownerId, "write", tx);
      const current = await delegate(owner, tx).findFirst({
        where: { id: attId, ...ownerFilter(owner, ownerId), deletedAt: null },
      });
      if (!current) throw new HttpError(404, "Attachment not found");
      await auditedSoftDelete(AUDIT_MODEL[owner], attId, undefined, tx);
    }, SERIALIZABLE));
}
