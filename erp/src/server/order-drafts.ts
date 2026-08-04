import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";

/**
 * order-drafts.ts — THE documented unaudited mutation path this phase.
 *
 * Authorization, quoted verbatim from the approved design
 * (docs/superpowers/specs/2026-08-02-phase-3-orders-design.md §4, "Data model", the OrderDraft
 * model):
 *
 *   "Deliberately unaudited — the documented exception (the spec-level flag HANDOFF §5.3
 *   demands): drafts are pre-entity scratch; the real order save is the audited event;
 *   auditing a 2-second autosave cadence would flood the log with junk. The draft service is
 *   the only mutation path in the phase that bypasses `audited*`, and this paragraph is its
 *   authorization. It never contains another user's data and is readable/writable only by its
 *   own user."
 *
 * Every write below goes straight to `prisma.orderDraft` — no auditedCreate/auditedUpdate/
 * auditedSoftDelete, no `$transaction`. Do not "fix" that: tests/order-drafts.test.ts asserts
 * `auditLog.count()` stays 0 across put/get/clear (design spec §12.7, "Draft lifecycle").
 *
 * Own-row-only is structural, not a permission check: every query below is keyed on the
 * `userId` the caller passes in (Task 10's route supplies the session user's own id — never a
 * client-chosen one), so there is nothing here that could read or write another user's draft.
 *
 * "Cleared ... on successful save or explicit discard — an update, not a delete" (same
 * section): `clearDraft` sets `payload` to `Prisma.DbNull` (SQL NULL) via `updateMany`, the
 * exact write `createOrder` already performs inline on save (src/server/orders.ts) — never a
 * `delete`, and a harmless no-op (not a 404) when the user has no draft row yet.
 */

// "payload ≤ 256 KB serialized" — the task-7 cap. Measured as the UTF-8 byte length of the same
// JSON text that will actually be stored, not the JS string length (multi-byte characters would
// otherwise undercount).
const MAX_DRAFT_BYTES = 256 * 1024;

export async function getDraft(userId: string): Promise<{ payload: unknown; updatedAt: Date } | null> {
  // `userId` is a plain `@unique` here (OrderDraft has no `deletedAt` — it is not soft-deletable),
  // so `findUnique` is exactly right; it is only banned on partial-unique columns.
  const row = await prisma.orderDraft.findUnique({ where: { userId } });
  if (!row) return null;
  return { payload: row.payload, updatedAt: row.updatedAt };
}

export async function putDraft(userId: string, payload: unknown): Promise<void> {
  const serialized = JSON.stringify(payload) ?? "null";
  if (Buffer.byteLength(serialized, "utf8") > MAX_DRAFT_BYTES) {
    throw new HttpError(400, `Draft payload exceeds the ${MAX_DRAFT_BYTES / 1024} KB limit`);
  }
  // A bare JS `null`/`undefined` is ambiguous to Prisma's Json input (SQL NULL vs. the JSON
  // literal null) and throws if passed straight through — `Prisma.JsonNull` says explicitly
  // "store the JSON value null", as opposed to `clearDraft`'s `Prisma.DbNull` ("no draft").
  const value = payload == null ? Prisma.JsonNull : (payload as Prisma.InputJsonValue);
  await prisma.orderDraft.upsert({
    where: { userId },
    create: { userId, payload: value },
    update: { payload: value },
  });
}

export async function clearDraft(userId: string): Promise<void> {
  // `updateMany`, not `update`: a user with no draft row yet (nothing ever autosaved) must clear
  // silently rather than 404 — matches createOrder's own inline clear-on-save.
  await prisma.orderDraft.updateMany({ where: { userId }, data: { payload: Prisma.DbNull } });
}
