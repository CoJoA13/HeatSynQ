import { prisma } from "./db";
import { currentActor } from "./context";
import type { Prisma } from "@prisma/client";

export type AuditableModel =
  | "user" | "role" | "setting"
  | "glAccount" | "material" | "inspectionScale" | "inspectionCode" | "containerType"
  | "carrier" | "terms" | "paymentType" | "commentSnippet" | "specification"
  | "processStepCode" | "customer" | "customerAddress" | "customerContact";

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
  model: AuditableModel, data: object, doIt: () => Promise<T>, opts?: { tx?: Prisma.TransactionClient },
): Promise<T> {
  const created = await doIt();
  await write({ entity: model, entityId: created.id, action: "create", after: data }, opts?.tx ?? prisma);
  return created;
}

export async function auditedUpdate<T>(
  model: AuditableModel, id: string, doIt: () => Promise<T>,
  opts?: { reason?: string; tx?: Prisma.TransactionClient },
): Promise<T> {
  const db = opts?.tx ?? prisma;
  const before = await snapshot(model, id, db);
  const result = await doIt();
  const after = await snapshot(model, id, db);
  await write({ entity: model, entityId: id, action: "update", before, after, reason: opts?.reason }, db);
  return result;
}

export async function auditedSoftDelete(
  model: AuditableModel, id: string, reason?: string, tx?: Prisma.TransactionClient,
): Promise<void> {
  const db = tx ?? prisma;
  const before = await snapshot(model, id, db);
  const client = db[model] as unknown as {
    update: (a: { where: { id: string }; data: { deletedAt: Date } }) => Promise<unknown>;
  };
  await client.update({ where: { id }, data: { deletedAt: new Date() } });
  await write({ entity: model, entityId: id, action: "delete", before, reason }, db);
}

export function readAudit(entity: string, entityId: string) {
  return prisma.auditLog.findMany({ where: { entity, entityId }, orderBy: { at: "desc" } });
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
