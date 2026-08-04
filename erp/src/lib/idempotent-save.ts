"use client";
// Client-safe: no src/server imports (CLAUDE.md — a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle).
//
// Fix-wave R4 finding 5. Two tabs can resume the SAME autosaved order draft, and both can Save.
// The order save is Serializable, so one of them loses on `allocateNumber` and gets 40001 -> the
// retryable 409 — and the entry page retries it automatically, correctly, because that 409 is the
// documented "wrote nothing, consumed no number" outcome. What was wrong was that the retry
// looked to the server like a brand-new request: it allocated the NEXT order number and created a
// second order for one operator action. Two orders for one job is the double-billing adjacency
// this project exists to prevent (spec §15).
//
// The fix is a nonce that identifies the INTENT rather than the attempt. It is minted once, when a
// fresh entry form mounts, and stored INSIDE the draft payload — so a second tab resuming that
// same draft carries the same nonce, and so does the loser's retry. The server (createOrder,
// src/server/orders.ts) stores it on the order and, on a collision, returns the order that
// request already created instead of making another.
//
// Both halves live here, as pure functions, because vitest runs `environment: "node"` and this
// codebase has no component-test harness — the same reason `computeOrphanChurn` (bulk-grid.ts)
// and `makeLatestGate` (use-latest.ts) were extracted.
import { ApiError } from "./fetcher";

/** Exactly the shape `crypto.randomUUID()` produces (RFC 4122 v4). Deliberately narrower than the
 *  server's own `z.string().uuid()`: anything this accepts is guaranteed to survive that check,
 *  so a draft can never carry a nonce the save will reject. */
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The nonce for a resumed draft: whatever it already carries, if that is a real v4 uuid, and a
 * fresh one otherwise.
 *
 * KEEPING the stored value is the entire mechanism — it is what makes two tabs on one draft, and
 * a retry of one tab's save, all the same request. Minting is the fallback for a draft autosaved
 * before this field existed, and for a payload whose stored value is unusable (`OrderDraft.payload`
 * is opaque Json, so it is normalized defensively on the way in like every other field of it).
 */
export function normalizeRequestNonce(raw: unknown): string {
  return typeof raw === "string" && V4.test(raw) ? raw : crypto.randomUUID();
}

/**
 * Submits once, and on a 409 submits THE SAME `body` again — the one retry the T4-measured
 * concurrent-save behaviour licenses, and no more (a second 409 is reported rather than looped
 * on, so a persistently contended save fails visibly instead of hammering).
 *
 * `body` is passed through by reference on purpose, and the caller must build it ONCE before the
 * first attempt. Rebuilding it for the retry would mint a new nonce and recreate the very
 * duplicate this whole mechanism exists to prevent — which is why that identity is asserted in
 * tests/idempotent-save.test.ts rather than left as a convention to remember.
 */
export async function submitWithConflictRetry<Body, Result>(
  body: Body, submit: (body: Body) => Promise<Result>,
): Promise<Result> {
  try {
    return await submit(body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return submit(body);
    throw e;
  }
}
