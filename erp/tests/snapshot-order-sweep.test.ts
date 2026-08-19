import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { SNAPSHOT_INCLUDE, SNAPSHOT_SELECT } from "@/server/audit";
import { setRolePermissions } from "@/server/roles";

const SCHEMA = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

/** Every `model X { … }` block in the schema, as [name, body] pairs (the partial-unique-sweep
 *  parse — the generated v7 client exposes no runtime DMMF, so schema TEXT is the source). */
function models(): [string, string][] {
  return [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => [m[1], m[2]]);
}

/**
 * Per model: every RELATION field, `fieldName -> { target, isList }`. A field line is
 * `name Type[]` (list) / `name Type` / `name Type?` (to-one); it is a relation only when `Type`
 * names another model — that filter is what keeps scalar fields (and any future scalar list,
 * `String[]`) out of the map. `[ \t]+` not `\s+`, the partial-unique-sweep lesson: `\s+` bridges
 * newlines and lets a reformat silently misparse.
 */
function relationsByModel(): Map<string, Map<string, { target: string; isList: boolean }>> {
  const modelNames = new Set(models().map(([name]) => name));
  const byModel = new Map<string, Map<string, { target: string; isList: boolean }>>();
  for (const [name, body] of models()) {
    const fields = new Map<string, { target: string; isList: boolean }>();
    for (const m of body.matchAll(/^[ \t]*(\w+)[ \t]+(\w+)(\[\])?/gm)) {
      const [, field, type, list] = m;
      if (modelNames.has(type)) fields.set(field, { target: type, isList: list === "[]" });
    }
    byModel.set(name, fields);
  }
  return byModel;
}

/** An AuditableModel key is the Prisma model name with its first letter lowercased — the same
 *  derivation snapshot() relies on for its delegate lookup, and the same one Part B's claim uses
 *  for its table identifier. */
const modelNameFor = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

describe("snapshot order sweep (#24)", () => {
  // HistoryPanel diffs whole keys via JSON.stringify, which is order-sensitive — an unordered
  // list relation in a snapshot makes two snapshots of IDENTICAL data render as a spurious diff
  // whenever Postgres's scan order shifts (and it can shift on any plan change, vacuum, or
  // delete/recreate). The fix belongs at snapshot CAPTURE, never at render: once two unordered
  // snapshots are stored, no renderer can distinguish a genuine reorder from scan noise. Every
  // ordered include already in audit.ts is the precedent; this sweep is what keeps the NEXT
  // entry from shipping unordered.
  it("every list relation included or selected into a snapshot carries an orderBy", () => {
    const relations = relationsByModel();
    expect(relations.size).toBeGreaterThan(0); // the sweep is worthless if the parse silently fails

    const offenders: string[] = [];
    const visited: string[] = [];

    // Walks an include- or select-shape against the model it projects. Keys that are not
    // relation fields (scalars in a select) are skipped — shape VALIDITY is certs-schema
    // .test.ts's smoke test's job, ordering is this sweep's. Recursion follows nested
    // `include`/`select` clauses into the related model, so a list buried two levels down
    // (order.lines.include → OrderLine, cert.requirements.include.readings) is swept too.
    function walk(model: string, shape: Record<string, unknown>, path: string): void {
      const fields = relations.get(model);
      for (const [field, val] of Object.entries(shape)) {
        const rel = fields?.get(field);
        if (!rel) continue;
        if (rel.isList) {
          visited.push(`${path}.${field}`);
          const ordered = typeof val === "object" && val !== null && Object.hasOwn(val, "orderBy");
          if (!ordered) offenders.push(`${path}.${field} (${model}.${field}: ${rel.target}[])`);
        }
        if (typeof val === "object" && val !== null) {
          for (const clause of ["include", "select"] as const) {
            const nested = (val as Record<string, unknown>)[clause];
            if (nested && typeof nested === "object") {
              walk(rel.target, nested as Record<string, unknown>, `${path}.${field}.${clause}`);
            }
          }
        }
      }
    }

    const maps: [string, Partial<Record<string, object | undefined>>][] = [
      ["SNAPSHOT_INCLUDE", SNAPSHOT_INCLUDE],
      ["SNAPSHOT_SELECT", SNAPSHOT_SELECT],
    ];
    for (const [mapName, map] of maps) {
      for (const [key, shape] of Object.entries(map)) {
        if (!shape) continue;
        walk(modelNameFor(key), shape as Record<string, unknown>, `${mapName}.${key}`);
      }
    }

    expect(visited.length).toBeGreaterThan(0); // a broken walk must not silently pass the sweep
    expect(offenders, `These snapshot collections have no orderBy. An unordered list relation
makes two snapshots of identical data compare as a spurious diff (HistoryPanel's whole-key
JSON.stringify comparison is order-sensitive). Add an orderBy at snapshot capture — a stable
column, with { id: "asc" } as a trailing tie-break when the column is not unique within the
parent.`).toEqual([]);
  });

  // Backs snapshot()'s delegate lookup AND the #9 claim's table-name derivation: both turn an
  // AuditableModel key into an identifier by uppercasing the first letter. No @@map appears
  // anywhere in schema.prisma, so the Prisma model name IS the Postgres table name — this pins
  // that every key round-trips to a real model before either derivation can silently miss.
  it("every AuditableModel key maps to a schema model by uppercasing its first letter", () => {
    const modelNames = new Set(models().map(([name]) => name));
    const unmapped = Object.keys(SNAPSHOT_INCLUDE).filter((key) => !modelNames.has(modelNameFor(key)));
    expect(unmapped).toEqual([]);
  });
});

describe("snapshot order — behavioral pin (#24)", () => {
  beforeEach(truncateAll);

  const asSystem = <T>(fn: () => Promise<T>) =>
    runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

  // The delete/recreate inside setRolePermissions mints NEW RolePermission rows every save, so
  // the comparison is per permission KEY, not per row (ids legitimately differ). With the
  // ordered include, a re-save of the same set — whatever order the client delivered it in —
  // snapshots the same key sequence on both sides of the entry: no spurious diff.
  it("re-saving the same permission set in a different delivery order snapshots identically", async () => {
    const role = await prisma.role.create({ data: { name: "Ops" } });
    await asSystem(() => setRolePermissions(role.id, ["parts.view", "orders.view", "customers.view"]));
    await asSystem(() => setRolePermissions(role.id, ["customers.view", "parts.view", "orders.view"]));

    const entries = await prisma.auditLog.findMany({
      where: { entity: "role", entityId: role.id, action: "update" },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    expect(entries).toHaveLength(2);

    const perms = (snap: unknown) =>
      (snap as { permissions: { permission: string }[] }).permissions.map((p) => p.permission);
    expect(perms(entries[1].after)).toEqual(perms(entries[1].before));
  });
});
