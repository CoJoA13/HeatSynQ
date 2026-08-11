import { prisma } from "./db";
import { currentActor } from "./context";
import { HttpError } from "./errors";
import type { Prisma } from "../../prisma/generated/prisma/client";

export type AuditableModel =
  | "user" | "role" | "setting"
  | "glAccount" | "material" | "inspectionScale" | "inspectionCode" | "containerType"
  | "carrier" | "terms" | "paymentType" | "commentSnippet" | "specification"
  | "processStepCode" | "customer" | "customerAddress" | "customerContact"
  | "part" | "partSpecification" | "partInspection" | "partPrice" | "partPriceBreak"
  | "partFieldDef" | "partFieldValue"
  | "partProcessRevision" | "processTemplate"
  | "order" | "partAttachment" | "orderAttachment" | "savedView" | "storedDocument"
  | "cert" | "shipper"
  | "surcharge" | "surchargeStepCode" | "customerSurcharge"
  | "invoice" | "invoiceLine" | "billingConfig"
  | "receiptBatch" | "payment" | "application"
  | "closePeriod" | "glExportBatch"
  | "quote" | "endingStatement";

// Relations pulled into before/after snapshots so audit history reflects changes made through
// associated tables (setRolePermissions, setUserOverrides) and not just scalar columns on the
// model row itself. `undefined` means "no relations" — snapshot() falls back to a bare
// findUnique for that model. These relations carry no sensitive fields (permission/mode keys
// only), so redact() doesn't need new patterns to keep snapshots safe.
// Exported for tests/certs-schema.test.ts's smoke test: this map is typed `object | undefined`
// per entry (Prisma's own `include` shape has no useful common supertype), so a wrong relation
// name or `orderBy` field compiles cleanly and would otherwise only explode at the first
// `audited*` call against that model, in whatever later task happens to be the first to touch it.
export const SNAPSHOT_INCLUDE: Record<AuditableModel, object | undefined> = {
  role: { permissions: true },
  user: { overrides: true },
  setting: undefined,
  glAccount: undefined,
  material: undefined,
  inspectionScale: undefined,
  inspectionCode: undefined,
  containerType: undefined,
  carrier: undefined,
  terms: undefined,
  paymentType: undefined,
  commentSnippet: undefined,
  specification: undefined,
  // Field definitions are mutated through the parent (setStepFields deletes/recreates
  // ProcessStepFieldDef rows), not via a scalar column on ProcessStepCode itself — without this
  // include, before/after snapshots would both omit `fields` and the diff would show no change
  // for the exact operation most worth auditing.
  processStepCode: { fields: true },
  // Addresses and contacts (Task 5/6) are audited as their own models, so the parent snapshot
  // needs no relations.
  customer: undefined,
  customerAddress: undefined,
  customerContact: undefined,
  // children are audited as their own models
  part: undefined,
  // history reads "ASTM A536", not a cuid
  partSpecification: { specification: true },
  partInspection: { inspectionCode: true, scale: true },
  // A price row's breaks are edited through the row, so the row-level diff is only meaningful
  // with them included (ordered — issue #24), and its step code is selected in so history reads
  // "HT — Harden", not a cuid. Breaks are ALSO audited as their own model when edited directly.
  // `threshold` is unique only among LIVE breaks (partial index) — a soft-deleted break's threshold
  // can be re-added, so an unfiltered include can pull two breaks sharing one threshold into a
  // snapshot (order becomes non-deterministic vs `threshold asc` alone) and surfaces a break the
  // live UI (`getPartPrices`, `deletedAt: null`) never shows. Filtering to live rows makes
  // `threshold` deterministic again and matches the live read.
  partPrice: {
    breaks: { where: { deletedAt: null }, orderBy: [{ threshold: "asc" }] },
    processStepCode: { select: { code: true, name: true } },
  },
  partPriceBreak: undefined,
  partFieldDef: undefined,
  // history names the field the value belongs to
  partFieldValue: { field: true },
  // Steps and values are mutated through the parent revision (part-process-steps.ts wraps every
  // step/value write in one auditedUpdate against the revision, spec §8) — the revision-level
  // before/after diff is only meaningful with its steps (ordered), each step's live code
  // (code/name — renames propagate, spec §3.3), and each value's live field def (label) included.
  partProcessRevision: {
    steps: {
      orderBy: { position: "asc" },
      include: {
        code: { select: { code: true, name: true } },
        // Fix-wave Finding 4 (2026-08-02 final review): no orderBy here meant a snapshot's row
        // order tracked Postgres's own scan order rather than being deterministic — two snapshots
        // of otherwise-identical state could render as a spurious diff (HistoryPanel diffs whole
        // keys via JSON.stringify, which is order-sensitive). Explicit ascending order makes two
        // snapshots of the same value set always compare equal regardless of insertion history.
        values: { orderBy: { fieldDefId: "asc" }, include: { fieldDef: { select: { label: true } } } },
      },
    },
  },
  // Template steps are mutated through the parent template (process-templates.ts wraps every
  // step write in one auditedUpdate against the template, spec §8) — the template-level
  // before/after diff is only meaningful with its ordered steps and each step's live code
  // (code/name — renames propagate, spec §3.3) included.
  processTemplate: {
    steps: { orderBy: { position: "asc" }, include: { code: { select: { code: true, name: true } } } },
  },
  // Order's children (lines/containers/serials/loads/charges) have no deletedAt of their own —
  // editing them IS editing the order (design spec §4), audited as the order's own before/after
  // diff, never as a separate entity. Every collection below is explicitly orderBy'd (issue #24:
  // an unordered collection makes two snapshots of identical data compare as a spurious diff,
  // since HistoryPanel's whole-key JSON.stringify comparison is order-sensitive) and each line's
  // live part number / each container's live type name is pulled in so the diff reads "P-1002",
  // not a cuid.
  order: {
    lines: { orderBy: { position: "asc" }, include: { part: { select: { partNumber: true } } } },
    containers: { orderBy: { position: "asc" }, include: { type: { select: { name: true } } } },
    // lineId is an opaque cuid — ordering by it made snapshot order arbitrary with respect to the
    // order the operator actually entered lines in, so a later line insert could produce a
    // spurious diff (issue #24's class of bug). Order by the line's own position instead, which
    // agrees with DETAIL_INCLUDE.serials (orders.ts) and the create-path auditPayload below.
    serials: { orderBy: [{ line: { position: "asc" } }, { position: "asc" }] },
    loads: { orderBy: { loadNumber: "asc" } },
    charges: { orderBy: { position: "asc" } },
  },
  // Attachments and saved views are audited as their own rows, not through a parent — no
  // relations to include. `undefined` here just means "no relations"; SNAPSHOT_SELECT below (not
  // this record) is what actually keeps fileData out of these three models' snapshots — see its
  // own comment.
  partAttachment: undefined,
  orderAttachment: undefined,
  savedView: undefined,
  // Permanent, create-only (design spec §4: "no delete path at all") — snapshots are metadata
  // only, fileData excluded the same way as the attachment tables (SNAPSHOT_SELECT below).
  storedDocument: undefined,
  // Cert and Shipper children have no deletedAt of their own — editing them IS editing the
  // document (Phase 4 spec §4.1/§4.2), audited as its own before/after diff, never as a separate
  // entity. That is the same call Order's children got, and it is what makes these includes
  // load-bearing rather than decorative: without them, filling in every reading on a cert would
  // diff as no change at all.
  //
  // Every collection below is explicitly orderBy'd — issue #24 applied from birth. HistoryPanel
  // compares whole keys with JSON.stringify, which is order-sensitive, so an unordered collection
  // makes two snapshots of identical data render as a spurious diff. Live code/scale/part names
  // are selected in so the diff reads "Hardness", not a cuid.
  cert: {
    requirements: {
      orderBy: { position: "asc" },
      include: {
        inspectionCode: { select: { name: true } },
        scale: { select: { name: true } },
        readings: { orderBy: { position: "asc" } },
      },
    },
  },
  // Task 8 review (2026-08-04, carried forward from Task 2): the original include here pulled
  // `order: { select: { orderNumber: true } }` only — a diff on `Shipper.customerId`,
  // `carrierId` or `shipToAddressId` rendered as a raw cuid, exactly the unreadable-history shape
  // issue #24 exists to prevent. `customer`/`carrier`/`shipToAddress` are all selected directly on
  // the SHIPPER itself (round 2 of the same review, 2026-08-04) — not read off `orders[].order`
  // alone, because `ShipperOrder` has no `deletedAt` of its own (spec §4.2) and Task 9's
  // `removeOrderFromShipper` hard-deletes the row. That same task's `removeOrderFromShipper` now
  // also refuses to remove a shipment's LAST order (§4.2's "at least one line with qty > 0 across
  // all its orders" enforced at the document level), so an order-less shipment isn't actually
  // reachable through that path any more — this select stays anyway, as cheap defensive insurance
  // against a raw cuid ever surfacing in a history diff.
  shipper: {
    customer: { select: { code: true, name: true } },
    carrier: { select: { name: true } },
    shipToAddress: { select: { name: true } },
    orders: {
      orderBy: { position: "asc" },
      include: {
        order: { select: { orderNumber: true, customer: { select: { code: true, name: true } } } },
        lines: { orderBy: { position: "asc" }, include: { orderLine: { select: { position: true } } } },
        containers: { orderBy: { position: "asc" } },
        // ShipperSerial has no position of its own (a serial is either on the ticket or not),
        // and `orderSerialId` stopped being a stable key when snapshot + release made it nullable
        // (several released rows tie at null, and Postgres breaks the tie arbitrarily — an
        // order-sensitive before/after diff then reports unchanged serials as modified). The
        // snapshot column orders; `id` breaks a duplicate-serial tie deterministically.
        serials: { orderBy: [{ serial: "asc" }, { id: "asc" }] },
      },
    },
  },
  // Phase 5A. A surcharge's include/exclude list is a replace-grid edited through the parent, so
  // the parent's diff needs it; a customer's override row names the surcharge it refines. Every
  // collection is explicitly orderBy'd — issue #24 applied at the point of writing.
  surcharge: {
    stepCodes: {
      orderBy: { processStepCodeId: "asc" },
      include: { processStepCode: { select: { code: true, name: true } } },
    },
    glAccount: { select: { name: true } },
  },
  surchargeStepCode: undefined,
  customerSurcharge: { surcharge: { select: { name: true } } },
  // Invoice lines have no deletedAt of their own — editing them IS editing the invoice (§5.5),
  // audited as the invoice's own before/after diff. Live customer/order/step-code/GL names are
  // selected in so the diff reads "ACME" and "4010", never a cuid.
  invoice: {
    customer: { select: { code: true, name: true } },
    order: { select: { orderNumber: true } },
    lines: {
      orderBy: { position: "asc" },
      include: {
        processStepCode: { select: { code: true, name: true } },
        glAccount: { select: { name: true } },
      },
    },
  },
  invoiceLine: undefined,
  billingConfig: undefined,
  // Phase 5B A/R. A batch's payments and a payment's applications are audited as their OWN models
  // (receipts.ts/applications.ts wrap each in its own audited* call), so the parent snapshots pull
  // in only the live reference name history would otherwise render as a cuid — the partInspection
  // `{ inspectionCode: true }` precedent. A payment names its method; an application names the
  // invoice it reduces by that invoice's order number (the 5A invoice FK-with-live-name pattern).
  // Task 8 carry (progress.md deferred-minors, Task 2): a CREDIT-type application also names its
  // SOURCE credit the same way, so a voided credit application's audit entry reads the credit's
  // order number and credit number in history, not a bare `creditInvoiceId` cuid.
  receiptBatch: undefined,
  payment: { paymentType: true },
  application: {
    invoice: { select: { id: true, kind: true, creditNumber: true, order: { select: { orderNumber: true } } } },
    creditInvoice: { select: { id: true, kind: true, creditNumber: true, order: { select: { orderNumber: true } } } },
  },
  closePeriod: undefined,
  glExportBatch: { postings: true }, // the export's audit trail is its batch + the postings it emitted
  // Phase 6. A quote's lines, price rows, and breaks are edited through the parent document
  // (array-replace, the invoice-lines shape) — the quote-level diff is only meaningful with the
  // whole tree included. Live rows only (the partPrice precedent: a soft-deleted child would
  // surface rows the live read never shows, and QuotePrice's composite / QuotePriceBreak's
  // threshold are unique only among live rows, so an unfiltered include makes ordering
  // non-deterministic). Every collection is explicitly orderBy'd (issue #24 — HistoryPanel's
  // whole-key JSON.stringify comparison is order-sensitive; `id` breaks position ties, which are
  // service-managed, not DB-unique, on these tables). Live contact/ending-statement/user/part/
  // step-code names are selected in so a diff reads "Quote line P-1002", never a cuid.
  quote: {
    customer: { select: { code: true, name: true } },
    contact: { select: { name: true } },
    endingStatement: { select: { name: true } },
    quotedBy: { select: { displayName: true } },
    closedBy: { select: { displayName: true } },
    lines: {
      where: { deletedAt: null },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      include: {
        part: { select: { partNumber: true } },
        prices: {
          where: { deletedAt: null },
          orderBy: [{ position: "asc" }, { id: "asc" }],
          include: {
            processStepCode: { select: { code: true, name: true } },
            breaks: { where: { deletedAt: null }, orderBy: [{ threshold: "asc" }] },
          },
        },
      },
    },
  },
  // The eleventh reference kind (Phase 6 ruling 13) — audited through the generic reference
  // machinery Task 2 wires, exactly like commentSnippet/specification. No relations of its own.
  endingStatement: undefined,
};

/**
 * Per-model `select` override for `snapshot()` below — used INSTEAD of `include` (never both;
 * Prisma rejects a query carrying both) for any model whose own bytes column must never be
 * pulled into a before/after snapshot in the first place. Fix-wave finding 3: before this, the
 * three models below were audited via the bare `include`-driven `findUnique` at the bottom of
 * this file, which has no column projection at all — a soft-delete's own "before" snapshot
 * (`auditedSoftDelete`) fetched up to a 20MB `fileData` column, JSON-round-tripped it
 * (`JSON.parse(JSON.stringify(...))` inside `redact()`), and only THEN scrubbed the key to
 * `"[redacted]"` — real memory pressure on every attachment delete, for a value nothing ever
 * needed in the first place. Listing every scalar except the bytes column here means the bytes
 * never leave Postgres for this codepath at all; `redact()` stays defense-in-depth (CLAUDE.md),
 * not the mechanism relied on to keep them out.
 *
 * Relations are deliberately omitted (these three are audited as their own rows, matching
 * SNAPSHOT_INCLUDE's own comment above them). `storedDocument` has no update/delete path today
 * (`auditedCreate` never calls `snapshot()` — see its own doc comment), so this entry is
 * currently unreached; it is defined anyway so the exclusion already exists the moment that
 * changes, rather than being something a future phase has to remember to add.
 */
const SNAPSHOT_SELECT: Partial<Record<AuditableModel, object>> = {
  partAttachment: {
    id: true, partId: true, filename: true, mimeType: true, size: true,
    active: true, deletedAt: true, createdAt: true, updatedAt: true,
  },
  orderAttachment: {
    id: true, orderId: true, filename: true, mimeType: true, size: true,
    active: true, deletedAt: true, createdAt: true, updatedAt: true,
  },
  // Phase 4 widened this table from one owner to three; Phase 5A added invoiceId, 5B added
  // customerId, and Phase 6 added quoteId. The list stays "every scalar except fileData", so each
  // new owner column belongs here the moment it exists rather than being something a later phase
  // has to remember.
  storedDocument: {
    id: true, orderId: true, shipperId: true, certId: true, invoiceId: true, customerId: true,
    quoteId: true,
    kind: true, loadNumber: true, createdAt: true,
  },
  // Task 12: `User.signatureImage` is a bytes column exactly like the three above, and gets the
  // same treatment — an explicit `select` (never `include`, which pulls every scalar including
  // this one) that lists every OTHER User scalar plus the `overrides` relation SNAPSHOT_INCLUDE's
  // `user` entry already carries, so `setSignature`'s own `auditedUpdate("user", ...)` never pulls
  // the image bytes into a before/after snapshot in the first place. redact()'s "signatureimage"
  // pattern stays defense-in-depth, not the mechanism relied on to keep them out (CLAUDE.md).
  user: {
    id: true, username: true, passwordHash: true, displayName: true, roleId: true,
    active: true, deletedAt: true, createdAt: true, updatedAt: true, signatureMimeType: true,
    overrides: true,
  },
};

export function redact(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

  const sensitiveKeyPatterns = ["passwordhash", "password", "token", "secret", "signatureimage", "filedata"];

  function redactRecursive(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) {
      return obj.map((item) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          return redactRecursive(item);
        }
        return item;
      });
    }
    if (typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        const keyLower = key.toLowerCase();
        const isSensitive = sensitiveKeyPatterns.some((pattern) => keyLower.includes(pattern));
        if (isSensitive) {
          result[key] = "[redacted]";
        } else if (val !== null && typeof val === "object" && !Array.isArray(val)) {
          result[key] = redactRecursive(val);
        } else if (Array.isArray(val)) {
          result[key] = redactRecursive(val);
        } else {
          result[key] = val;
        }
      }
      return result;
    }
    return obj;
  }

  return redactRecursive(clone) as Prisma.InputJsonValue;
}

// Anything that behaves like the top-level Prisma client for the purposes of snapshot/write --
// either `prisma` itself or the `tx` a caller received from its own `prisma.$transaction`. A
// caller running its mutation inside a transaction must pass that same `tx` through to the
// audited* helpers below (via `opts.tx`): reads made on the top-level client while a transaction
// holding the row's lock is still open see the pre-transaction row, not the write in progress
// (Postgres's default READ COMMITTED isolation blocks the read until the transaction commits or
// rolls back, then returns what was committed before it started). That produced Fix 1 from the
// final review -- an address rename inside `prisma.$transaction` snapshotted identical before/after
// because both snapshots ran on `prisma`, outside the transaction, while the update itself ran on
// `tx`. Passing `tx` through makes every snapshot and the audit write itself part of the same
// transaction as the mutation, so they see (and commit or roll back with) exactly what it wrote.
// `tx` on `auditedCreate`/`auditedUpdate`/`auditedSoftDelete` is required, not optional: the two
// autocommit statements this type once tolerated (mutation on `prisma`, audit insert on `prisma`)
// left an audit-write failure able to commit an unaudited mutation. Making it required lets the
// compiler enumerate every caller instead of trusting each one to opt in.
type Db = typeof prisma | Prisma.TransactionClient;

async function snapshot(model: AuditableModel, id: string, db: Db): Promise<unknown> {
  // Each auditable model has a string id primary key named `id`.
  const client = db[model] as unknown as {
    findUnique: (a: { where: { id: string }; select?: object; include?: object }) => Promise<unknown>;
  };
  const select = SNAPSHOT_SELECT[model];
  return select
    ? client.findUnique({ where: { id }, select })
    : client.findUnique({ where: { id }, include: SNAPSHOT_INCLUDE[model] });
}

async function write(entry: {
  entity: string; entityId: string; action: string;
  before?: unknown; after?: unknown; reason?: string;
}, db: Db) {
  const actor = currentActor();
  await db.auditLog.create({
    data: {
      actorId: actor.id,
      actorName: actor.name,
      entity: entry.entity,
      entityId: entry.entityId,
      action: entry.action,
      before: redact(entry.before),
      after: redact(entry.after),
      reason: entry.reason,
    },
  });
}

export async function auditSettingChange(key: string, beforeValue: unknown, afterValue: unknown): Promise<void> {
  const actor = currentActor();
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      actorName: actor.name,
      entity: "setting",
      entityId: key,
      action: "update",
      before: redact({ value: beforeValue }),
      after: redact({ value: afterValue }),
    },
  });
}

export async function auditedCreate<T extends { id: string }>(
  model: AuditableModel, data: object, doIt: () => Promise<T>, opts: { tx: Prisma.TransactionClient },
): Promise<T> {
  const created = await doIt();
  await write({ entity: model, entityId: created.id, action: "create", after: data }, opts.tx);
  return created;
}

export async function auditedUpdate<T>(
  model: AuditableModel, id: string, doIt: () => Promise<T>,
  opts: { tx: Prisma.TransactionClient; reason?: string },
): Promise<T> {
  const db = opts.tx;
  const before = await snapshot(model, id, db);
  const result = await doIt();
  const after = await snapshot(model, id, db);
  await write({ entity: model, entityId: id, action: "update", before, after, reason: opts.reason }, db);
  return result;
}

/**
 * The soft-delete write is conditional on the row still being live, and the audit entry is only
 * written if that condition actually claimed the row.
 *
 * Callers pre-check with a `findFirst({ deletedAt: null })` so the ordinary "it's already gone"
 * case gets a well-labelled 404. That check cannot be the whole guard: it is a separate
 * statement from the write, so two overlapping deletes of the same row — an ordinary
 * double-click on a delete link — can both pass it before either commits. Updating by `id`
 * alone then let both succeed, the second re-stamping `deletedAt` with a later time and adding a
 * second "delete" entry to the history of a row that was deleted once. `updateMany` with
 * `deletedAt: null` in the WHERE makes the check and the write a single atomic statement:
 * whichever transaction gets there second matches no rows, writes nothing, and reports that the
 * record is already gone instead of inventing a second deletion.
 *
 * Fixing it here rather than in each caller covers all eight delete paths at once — including
 * roles, reference rows and process step codes, where handoff §6 recorded this same defect
 * ("a second DELETE re-stamps deletedAt and writes another audit row") as a carried item.
 */
export async function auditedSoftDelete(
  model: AuditableModel, id: string, reason: string | undefined, tx: Prisma.TransactionClient,
): Promise<void> {
  const db = tx;
  const before = await snapshot(model, id, db);
  const client = db[model] as unknown as {
    updateMany: (a: {
      where: { id: string; deletedAt: null }; data: { deletedAt: Date };
    }) => Promise<{ count: number }>;
  };
  const { count } = await client.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
  // Deliberately the same 404 the callers' own pre-check raises, so a racing loser is reported
  // exactly like a sequential repeat rather than as some new class of failure.
  if (count === 0) throw new HttpError(404, "That record has already been deleted");
  await write({ entity: model, entityId: id, action: "delete", before, reason }, db);
}

/**
 * `at` is millisecond-precision, so two entries written in the same millisecond — an edit and a
 * delete racing each other, or a cascade writing several rows at once — tie on it, and ordering
 * by `at` alone leaves their relative order up to the planner. That is what HistoryPanel renders,
 * so a tie could show a record's delete above an update that preceded it. `id` breaks the tie
 * deterministically: cuid is timestamp-prefixed and counter-sequenced, so within a process it
 * also breaks it in the right direction.
 */
export function readAudit(entity: string, entityId: string) {
  return prisma.auditLog.findMany({
    where: { entity, entityId },
    orderBy: [{ at: "desc" }, { id: "desc" }],
  });
}

export function searchAudit(filter: { entity?: string; actorName?: string; from?: Date; to?: Date; limit?: number }) {
  return prisma.auditLog.findMany({
    where: {
      ...(filter.entity ? { entity: filter.entity } : {}),
      ...(filter.actorName ? { actorName: { contains: filter.actorName, mode: "insensitive" } } : {}),
      ...(filter.from || filter.to ? { at: { gte: filter.from, lte: filter.to } } : {}),
    },
    orderBy: { at: "desc" },
    take: filter.limit ?? 200,
  });
}
