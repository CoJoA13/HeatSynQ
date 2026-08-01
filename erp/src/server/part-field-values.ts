import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate } from "./audit";

export type PartFieldValueRow = {
  fieldId: string; name: string; type: string; sort: number; active: boolean; value: string;
};

const VALUE_ITEM = z.object({ fieldId: z.string().min(1), value: z.string() }).strict();
const VALUES = z.array(VALUE_ITEM);

/** Values are stored as canonical strings; "" always means "unset" regardless of type. */
function validateValue(def: { name: string; type: string }, value: string): string {
  const v = value.trim();
  if (v === "") return "";
  switch (def.type) {
    case "NUMBER":
      if (!/^-?\d{1,12}(\.\d{1,6})?$/.test(v)) {
        throw new HttpError(400, `"${value}" is not a valid number for ${def.name}`);
      }
      return v;
    case "DATE":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
        throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${def.name}`);
      }
      return v;
    case "CHECKBOX":
      if (v !== "true" && v !== "false") {
        throw new HttpError(400, `${def.name} must be true or false`);
      }
      return v;
    default:
      if (v.length > 2000) throw new HttpError(400, `${def.name} is too long (2000 max)`);
      return v;
  }
}

/** Every LIVE def (active, or inactive-with-a-value on this part), sorted, joined with this
 *  part's values ("" when unset). Inactive hides a field from new entry, it does not invalidate a
 *  value already on the part (§5.14). */
export async function listPartFieldValues(partId: string): Promise<PartFieldValueRow[]> {
  const [part, defs, values] = await Promise.all([
    prisma.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } }),
    prisma.partFieldDef.findMany({ where: { deletedAt: null }, orderBy: { sort: "asc" } }),
    prisma.partFieldValue.findMany({ where: { partId } }),
  ]);
  if (!part) throw new HttpError(404, "Part not found");
  const byField = new Map(values.map((v) => [v.fieldId, v.value]));
  return defs
    .filter((d) => d.active || (byField.get(d.id) ?? "") !== "")
    .map((d) => ({
      fieldId: d.id, name: d.name, type: d.type, sort: d.sort, active: d.active,
      value: byField.get(d.id) ?? "",
    }));
}

/**
 * Serializable: this reads the live field defs and writes values — the write-skew partner of
 * `deletePartFieldDef`'s blocker guard (which reads values and writes the def), exactly like the
 * LOT/breaks pair in part-price-breaks.ts. Both Serializable is what lets Postgres abort the
 * interleaving that would otherwise leave a value pointing at a def this same instant deleted.
 */
export async function setPartFieldValues(
  partId: string, values: { fieldId: string; value: string }[],
): Promise<void> {
  const parsed = VALUES.parse(values);

  await withDbErrors({ entity: "Part field value" }, () =>
    prisma.$transaction(async (tx) => {
      const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
      if (!part) throw new HttpError(404, "Part not found");

      const fieldIds = [...new Set(parsed.map((v) => v.fieldId))];
      const defs = fieldIds.length
        ? await tx.partFieldDef.findMany({ where: { id: { in: fieldIds }, deletedAt: null } })
        : [];
      const defById = new Map(defs.map((d) => [d.id, d]));
      for (const v of parsed) {
        if (!defById.has(v.fieldId)) throw new HttpError(400, "That field does not exist");
      }

      for (const v of parsed) {
        const def = defById.get(v.fieldId)!;
        const value = validateValue(def, v.value);
        // findFirst, not findUnique: [partId, fieldId] is a HARD unique here (PartFieldValue has
        // no deletedAt — rows are never deleted, "" means unset), so findUnique is legal, but
        // findFirst matches the uniform pattern used everywhere else in this codebase.
        const existing = await tx.partFieldValue.findFirst({ where: { partId, fieldId: v.fieldId } });
        if (!existing) {
          await auditedCreate("partFieldValue", { partId, fieldId: v.fieldId, value }, () =>
            tx.partFieldValue.create({ data: { partId, fieldId: v.fieldId, value } }), { tx });
        } else if (existing.value !== value) {
          await auditedUpdate("partFieldValue", existing.id, () =>
            tx.partFieldValue.update({ where: { id: existing.id }, data: { value } }), { tx });
        }
        // identical value: skip — no junk audit rows.
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
