import { z } from "zod";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { currentActor } from "./context";
import { auditSettingChange } from "./audit";
import type { Prisma } from "../../prisma/generated/prisma/client";

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.number().int().min(min).max(max);

export const SETTINGS = {
  company_name: { schema: z.string(), default: "", label: "Company name", group: "Company" },
  company_address: { schema: z.string(), default: "", label: "Company address", group: "Company" },
  company_phone: { schema: z.string(), default: "", label: "Company phone", group: "Company" },
  order_number_next: { schema: int(1), default: 1000, label: "Next order number", group: "Numbering" },
  shipper_number_next: { schema: int(1), default: 1000, label: "Next shipper number", group: "Numbering" },
  invoice_number_next: { schema: int(1), default: 1000, label: "Next invoice number", group: "Numbering" },
  cert_number_next: { schema: int(1), default: 1000, label: "Next certification number", group: "Numbering" },
  quote_number_next: { schema: int(1), default: 1000, label: "Next quote number", group: "Numbering" },
  // Capped to match addBusinessDays' own guard (src/lib/business-days.ts, fix-wave finding 5) —
  // this value feeds straight into its day-at-a-time loop as the plant-wide default.
  request_days_default: { schema: int(0, 3650), default: 5, label: "Default request days", group: "Dates" },
  traffic_may_miss_days: { schema: int(0), default: 5, label: "May-miss window (days)", group: "Dates" },
  traffic_will_miss_days: { schema: int(0), default: 3, label: "Will-miss window (days)", group: "Dates" },
  session_timeout_minutes: { schema: int(5, 1440), default: 480, label: "Session timeout (minutes)", group: "System" },
} as const satisfies Record<string, { schema: z.ZodType; default: unknown; label: string; group: string }>;

export type SettingKey = keyof typeof SETTINGS;

export async function getSetting<K extends SettingKey>(key: K): Promise<z.infer<(typeof SETTINGS)[K]["schema"]>> {
  if (!Object.hasOwn(SETTINGS, key)) throw new HttpError(400, `Unknown setting: ${key}`);
  const row = await prisma.setting.findUnique({ where: { key } });
  const def = SETTINGS[key];
  const raw = row ? row.value : def.default;
  const parsed = def.schema.safeParse(raw);
  return (parsed.success ? parsed.data : def.default) as z.infer<(typeof SETTINGS)[K]["schema"]>;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  if (!Object.hasOwn(SETTINGS, key)) throw new HttpError(400, `Unknown setting: ${key}`);
  const def = SETTINGS[key as SettingKey];
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, `Invalid value for ${key}: ${parsed.error.issues[0]?.message}`);
  const actor = currentActor();
  const before = await prisma.setting.findUnique({ where: { key } });
  await prisma.setting.upsert({
    where: { key },
    update: { value: parsed.data as unknown as object, updatedBy: actor.name },
    create: { key, value: parsed.data as unknown as object, updatedBy: actor.name },
  });
  await auditSettingChange(key, before?.value ?? def.default, parsed.data);
}

// Allocation is deliberately unaudited: the consuming entity's own create entry records the
// number; owner edits to the seed still flow through setSetting + auditSettingChange.
export async function allocateNumber(key: SettingKey, tx: Prisma.TransactionClient): Promise<number> {
  if (!Object.hasOwn(SETTINGS, key)) throw new HttpError(400, `Unknown setting: ${key}`);
  const def = SETTINGS[key];
  await tx.setting.upsert({ where: { key }, create: { key, value: def.default as number }, update: {} });
  const [row] = await tx.$queryRaw<{ value: unknown }[]>`
    SELECT "value" FROM "Setting" WHERE "key" = ${key} FOR UPDATE`;
  const parsed = def.schema.safeParse(row.value);
  const current = (parsed.success ? parsed.data : def.default) as number;
  await tx.setting.update({ where: { key }, data: { value: current + 1 } });
  return current;
}

export async function allSettings() {
  const rows = await prisma.setting.findMany();
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
    const def = SETTINGS[key];
    const raw = stored.has(key) ? stored.get(key) : def.default;
    const parsed = def.schema.safeParse(raw);
    const value = parsed.success ? parsed.data : def.default;
    return {
      key,
      label: def.label,
      group: def.group,
      value,
    };
  });
}
