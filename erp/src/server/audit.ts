import { prisma } from "./db";
import { currentActor } from "./context";
import { HttpError } from "./errors";
import type { Prisma } from "../../prisma/generated/prisma/client";

export type AuditableModel =
  | "user" | "role" | "setting"
  | "glAccount" | "material" | "inspectionScale" | "inspectionCode" | "containerType"
  | "carrier" | "terms" | "paymentType" | "commentSnippet" | "specification"
  | "processStepCode" | "customer" | "customerAddress" | "customerContact"
  | "part" | "partSpecification" | "partInspection" | "partPriceBreak" | "partFieldDef" | "partFieldValue";

// Relations pulled into before/after snapshots so audit history reflects changes made through
// associated tables (setRolePermissions, setUserOverrides) and not just scalar columns on the
// model row itself. `undefined` means "no relations" — snapshot() falls back to a bare
// findUnique for that model. These relations carry no sensitive fields (permission/mode keys
// only), so redact() doesn't need new patterns to keep snapshots safe.
const SNAPSHOT_INCLUDE: Record<AuditableModel, object | undefined> = {
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
  partPriceBreak: undefined,
  partFieldDef: undefined,
  // history names the field the value belongs to
  partFieldValue: { field: true },
};

export function redact(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

  const sensitiveKeyPatterns = ["passwordhash", "password", "token", "secret", "signatureimage"];

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
    findUnique: (a: { where: { id: string }; include?: object }) => Promise<unknown>;
  };
  return client.findUnique({ where: { id }, include: SNAPSHOT_INCLUDE[model] });
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
