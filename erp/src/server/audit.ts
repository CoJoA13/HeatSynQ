import { prisma } from "./db";
import { currentActor } from "./context";
import type { Prisma } from "@prisma/client";

export type AuditableModel = "user" | "role" | "setting" | "glAccount";

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

async function snapshot(model: AuditableModel, id: string): Promise<unknown> {
  // Each auditable model has a string id primary key named `id`.
  const client = prisma[model] as unknown as {
    findUnique: (a: { where: { id: string }; include?: object }) => Promise<unknown>;
  };
  return client.findUnique({ where: { id }, include: SNAPSHOT_INCLUDE[model] });
}

async function write(entry: {
  entity: string; entityId: string; action: string;
  before?: unknown; after?: unknown; reason?: string;
}) {
  const actor = currentActor();
  await prisma.auditLog.create({
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
  model: AuditableModel, data: object, doIt: () => Promise<T>,
): Promise<T> {
  const created = await doIt();
  await write({ entity: model, entityId: created.id, action: "create", after: data });
  return created;
}

export async function auditedUpdate<T>(
  model: AuditableModel, id: string, doIt: () => Promise<T>, opts?: { reason?: string },
): Promise<T> {
  const before = await snapshot(model, id);
  const result = await doIt();
  const after = await snapshot(model, id);
  await write({ entity: model, entityId: id, action: "update", before, after, reason: opts?.reason });
  return result;
}

export async function auditedSoftDelete(model: AuditableModel, id: string, reason?: string): Promise<void> {
  const before = await snapshot(model, id);
  const client = prisma[model] as unknown as {
    update: (a: { where: { id: string }; data: { deletedAt: Date } }) => Promise<unknown>;
  };
  await client.update({ where: { id }, data: { deletedAt: new Date() } });
  await write({ entity: model, entityId: id, action: "delete", before, reason });
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
