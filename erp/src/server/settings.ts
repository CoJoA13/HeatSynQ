import { z } from "zod";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { currentActor } from "./context";
import { auditSettingChange } from "./audit";
import { CERT_SCOPES } from "@/lib/cert-constants";
import type { Prisma } from "../../prisma/generated/prisma/client";

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.number().int().min(min).max(max);

// Postgres's INTEGER (int4) column range — what Order.orderNumber (and every other *_number_next
// consumer downstream) actually stores the allocated value into. Fix-wave finding 8: nothing
// bounded these against it before, so a value past this wedged every create against the column
// with an opaque database error instead of a clean 400 where the setting is entered.
const INT4_MAX = 2_147_483_647;
const numberSeed = int(1, INT4_MAX);

// The four standing-text settings (cert_statement / shipper_liability_text / quote_intro_text /
// quote_liability_text) were RETIRED in Phase 7 Task 14: every document builder is now a
// config-consumer, and each standing text lives in its template's own text block (spec §8). Their
// values were COALESCE-copied into the seeded template configs in the Task 3 seed migration; the
// Setting rows are deleted by the 20260813120000_retire_standing_text_settings migration. The
// transcribed code defaults now live in the contract modules (src/lib/template-contracts/), which
// are the canonical copy.

export const SETTINGS = {
  company_name: { schema: z.string(), default: "", label: "Company name", group: "Company" },
  company_address: { schema: z.string(), default: "", label: "Company address", group: "Company" },
  company_phone: { schema: z.string(), default: "", label: "Company phone", group: "Company" },
  order_number_next: { schema: numberSeed, default: 1000, label: "Next order number", group: "Numbering" },
  shipper_number_next: { schema: numberSeed, default: 1000, label: "Next shipper number", group: "Numbering" },
  credit_number_next: { schema: numberSeed, default: 1000, label: "Next credit number", group: "Numbering" },
  // The invoice's number IS the order number (spec §3.2 — the sample's "7 −" is a plant/form
  // code, not a sequence). This prefix is what prints ahead of it.
  invoice_number_prefix: { schema: z.string(), default: "", label: "Invoice number prefix", group: "Numbering" },
  // Intentionally unused for the rest of the project — certifications carry no number of their own
  // (P4 §3.19) and an invoice is identified by its order number (5A §3.2). Left in place rather
  // than removed; do not wire either of these up to anything.
  invoice_number_next: { schema: numberSeed, default: 1000, label: "Next invoice number", group: "Numbering" },
  cert_number_next: { schema: numberSeed, default: 1000, label: "Next certification number", group: "Numbering" },
  quote_number_next: { schema: numberSeed, default: 1000, label: "Next quote number", group: "Numbering" },
  bol_number_next: { schema: numberSeed, default: 1000, label: "Next bill-of-lading number", group: "Numbering" },
  receipt_batch_number_next: {
    schema: numberSeed, default: 1000, label: "Next receipt-batch number", group: "Numbering",
  },
  gl_export_batch_number_next: {
    schema: numberSeed, default: 1000, label: "Next GL-export batch number", group: "Numbering",
  },
  cert_required_default: {
    schema: z.boolean(), default: false, label: "Certification required by default", group: "Certifications",
  },
  cert_scope_default: {
    schema: z.enum(CERT_SCOPES), default: "ORDER", label: "Default certification scope", group: "Certifications",
  },
  // (cert_statement / shipper_liability_text / quote_intro_text / quote_liability_text retired in
  // Phase 7 Task 14 — they are template text blocks now, see the note above the constants.)
  // Capped to match addBusinessDays' own guard (src/lib/business-days.ts, fix-wave finding 5) —
  // this value feeds straight into its day-at-a-time loop as the plant-wide default.
  request_days_default: { schema: int(0, 3650), default: 5, label: "Default request days", group: "Dates" },
  // Phase 6 (ruling 9): pre-fills a new quote's expiry as quoteDate + this many days, editable
  // per quote. Positive — a quote effective for zero days is a contradiction, not a default —
  // and capped like request_days_default above: the value feeds date arithmetic.
  quote_valid_days: { schema: int(1, 3650), default: 30, label: "Quote validity (days)", group: "Dates" },
  traffic_may_miss_days: { schema: int(0), default: 5, label: "May-miss window (days)", group: "Dates" },
  traffic_will_miss_days: { schema: int(0), default: 3, label: "Will-miss window (days)", group: "Dates" },
  session_timeout_minutes: { schema: int(5, 1440), default: 480, label: "Session timeout (minutes)", group: "System" },
} as const satisfies Record<string, { schema: z.ZodType; default: unknown; label: string; group: string }>;

export type SettingKey = keyof typeof SETTINGS;

/**
 * `db` defaults to the top-level `prisma` client — every existing caller that reads a setting
 * outside a transaction (the overwhelming majority) is unaffected. A caller mid-transaction (e.g.
 * `resolveCertSettings`, certs.ts) passes its own `tx` instead, so this read runs on that same
 * connection rather than borrowing a second one from the pool — the `readTravelerData`/
 * `readDetail` precedent (traveler.ts/orders.ts) of threading `db` through every read a
 * transaction-scoped function makes, generalized to settings (fix-wave R4 finding 8 fixed the
 * identical pool-starvation shape for `printTraveler`'s own reads).
 */
export async function getSetting<K extends SettingKey>(
  key: K, db: Prisma.TransactionClient = prisma,
): Promise<z.infer<(typeof SETTINGS)[K]["schema"]>> {
  if (!Object.hasOwn(SETTINGS, key)) throw new HttpError(400, `Unknown setting: ${key}`);
  const row = await db.setting.findUnique({ where: { key } });
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

// Every *_number_next key holds a number; every other SettingKey doesn't. Narrowing here (issue
// #34) stops a non-numeric key from reaching the string-concatenating increment below at the
// type level — before Phase 4 multiplies allocateNumber's call sites (shipper numbers, BOL
// numbers) on top of the one Phase 3 already has (order numbers).
export type NumberSettingKey = Extract<SettingKey, `${string}_number_next`>;

// Allocation is deliberately unaudited: the consuming entity's own create entry records the
// number; owner edits to the seed still flow through setSetting + auditSettingChange.
export async function allocateNumber(key: NumberSettingKey, tx: Prisma.TransactionClient): Promise<number> {
  if (!Object.hasOwn(SETTINGS, key)) throw new HttpError(400, `Unknown setting: ${key}`);
  // The template-literal type above is the real guard; this is the backstop for a caller that
  // reached here through a cast or an `any`. A non-numeric default would make the increment
  // below string-concatenate ("" + 1 → "1") and silently reissue numbers (issue #34).
  if (typeof SETTINGS[key].default !== "number") {
    throw new HttpError(400, `"${key}" is not a numbering key`);
  }
  const def = SETTINGS[key];
  // Seed the counter row atomically. This was `tx.setting.upsert(… update: {})`, which looks
  // atomic and is not: Prisma compiles an upsert to a native `INSERT … ON CONFLICT DO UPDATE`
  // ONLY when `update` is non-empty, and degrades an EMPTY `update: {}` to a two-statement
  // SELECT-then-INSERT. Two transactions allocating before the row exists therefore both read
  // "no row", both INSERT, and the loser dies on the `Setting` primary key — reachable on the
  // first allocation of a fresh install, after `truncateAll()`, and after a practice reset.
  // Written raw so the atomicity is stated in the SQL rather than resting on that ORM heuristic
  // (an `update: { key }` would also emit ON CONFLICT today, and would silently stop the day the
  // heuristic changes). DO NOTHING, not DO UPDATE: this statement only guarantees the row EXISTS
  // — the claim below is what serializes the readers, exactly as before.
  //
  // ⚠️ This closes the P2002 insert race ONLY. It does NOT make concurrent allocation safe under
  // Serializable, which is what every caller of this function actually runs: a transaction whose
  // snapshot was fixed before the claim below aborts with 40001 the moment another allocation
  // commits, and no caller retries (`retryOnSerializationConflict` is used only by
  // close-periods.ts). That is pre-existing, applies to every allocation after the first, and is
  // NOT fixed here — see issue #115. Do not read the tests below as covering it: vitest runs at
  // Read Committed, where the failure does not reproduce.
  await tx.$executeRaw`
    INSERT INTO "Setting" ("key", "value", "updatedAt")
    VALUES (${key}, ${JSON.stringify(def.default)}::jsonb, now())
    ON CONFLICT ("key") DO NOTHING`;
  const [row] = await tx.$queryRaw<{ value: unknown }[]>`
    SELECT "value" FROM "Setting" WHERE "key" = ${key} FOR UPDATE`;
  // Checked against the RAW stored value, ahead of the schema-fallback below — `def.schema`'s own
  // max is this same INT4_MAX, so a stored value past it fails `safeParse` and would otherwise
  // silently fall back to `def.default` (1000), quietly reissuing numbers already allocated
  // instead of the loud refusal a genuinely maxed-out counter needs (fix-wave finding 8). Reached
  // in practice once the increment below has stored `INT4_MAX + 1` in this Json column, which
  // holds it without complaint even though it could never be handed out as a real column value.
  if (typeof row.value === "number" && row.value > INT4_MAX) {
    throw new HttpError(400,
      `"${key}" has reached its maximum value (${INT4_MAX}) — an administrator must reset it in Settings`);
  }
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
