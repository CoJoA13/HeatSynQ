import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { linkOrder, unlinkOrder } from "@/server/order-edit";
import { HttpError } from "@/server/http";
import { parseDateOnly } from "@/lib/business-days";

/**
 * #214 — linkOrder's merge branch and unlinkOrder's last-survivor cascade must acquire EVERY
 * row they write through ONE `claimOrdersInOrder` statement, never through per-row locks in
 * findMany order. Before this fix the argument rows were claimed sorted but each member/survivor
 * write took its lock through auditedUpdate's own per-row FOR NO KEY UPDATE claim, in arbitrary
 * order — `unlinkOrder(A)` racing `unlinkOrder(B)` on group {A,B} was a genuine ABBA cycle
 * (T1 holds A wants B, T2 holds B wants A). Postgres breaks that with 40P01, which #90 maps to
 * an honest 409 — so the cost at HEAD was a deadlock_timeout stall plus a spurious "try again"
 * for a collision the claim discipline exists to make wait-only, not a 500.
 *
 * A raced deadlock is not a deterministic test, so the mechanism is pinned the way the claim
 * discipline itself is stated: hold a lock on a row the call must write but was NOT given as an
 * argument, and assert via pg_stat_activity that the statement blocked on it is the single
 * ordered claim (`… ORDER BY "id" FOR UPDATE`) — not auditedUpdate's per-row FOR NO KEY UPDATE
 * claim, which is exactly what sat there before the fix. Lock order inside one ordered statement
 * cannot cycle with another claimOrdersInOrder caller (order-locks.ts's own doc); a write-time
 * lock in loop order can.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let seq = 0;
async function customer() {
  seq += 1;
  return prisma.customer.create({ data: { code: `LNK${seq}`, name: `Link Locks ${seq}` } });
}

async function order(customerId: string, linkGroupId: string | null = null) {
  seq += 1;
  return prisma.order.create({
    data: {
      orderNumber: 700000 + seq, customerId, status: "OPEN", linkGroupId,
      receivedDate: parseDateOnly("2026-08-01"), requestDate: parseDateOnly("2026-08-01"),
    },
  });
}

/** Holds FOR UPDATE on one Order row until released; resolves `locked` once the lock is held. */
function holdOrderLock(orderId: string) {
  let release!: () => void;
  let lockedResolve!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const locked = new Promise<void>((r) => { lockedResolve = r; });
  const done = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    lockedResolve();
    await held;
  }, { timeout: 20_000 });
  return { locked, release, done };
}

/** Polls pg_stat_activity for a backend blocked on a lock whose statement is the ordered claim. */
async function watchForOrderedClaim(): Promise<{ saw: boolean; waiting: string[] }> {
  let waiting: string[] = [];
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const rows = await prisma.$queryRaw<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    waiting = rows.map((r) => r.query);
    if (waiting.some((q) => q.includes(`ORDER BY "id" FOR UPDATE`) && q.includes(`"Order"`))) {
      return { saw: true, waiting };
    }
  }
  return { saw: false, waiting };
}

describe("order link/unlink claim discipline (#214)", () => {
  beforeEach(async () => await truncateAll());

  it("unlinkOrder blocks on the SURVIVOR through the one ordered claim, before any write", async () => {
    const c = await customer();
    const group = crypto.randomUUID();
    const a = await order(c.id, group);
    const b = await order(c.id, group);

    const hold = holdOrderLock(b.id);
    await hold.locked;
    const attempt = asSystem(() => unlinkOrder(a.id));
    const { saw, waiting } = await watchForOrderedClaim();
    hold.release();
    await hold.done;
    await attempt;

    expect(saw, `expected the ordered claim to be the blocked statement; saw: ${JSON.stringify(waiting)}`).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).linkGroupId).toBeNull();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).linkGroupId).toBeNull();
  }, 20_000);

  it("linkOrder's merge blocks on an absorbed MEMBER through the one ordered claim, before any write", async () => {
    const c = await customer();
    const g1 = crypto.randomUUID();
    const g2 = crypto.randomUUID();
    const a = await order(c.id, g1);
    await order(c.id, g1);
    const target = await order(c.id, g2);
    const member = await order(c.id, g2); // written by the merge, never named as an argument

    const hold = holdOrderLock(member.id);
    await hold.locked;
    const attempt = asSystem(() => linkOrder(a.id, target.id));
    const { saw, waiting } = await watchForOrderedClaim();
    hold.release();
    await hold.done;
    await attempt;

    expect(saw, `expected the ordered claim to be the blocked statement; saw: ${JSON.stringify(waiting)}`).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: member.id } })).linkGroupId).toBe(g1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: target.id } })).linkGroupId).toBe(g1);
  }, 20_000);

  it("concurrent opposite unlinks settle as domain answers with the group fully dissolved", async () => {
    const c = await customer();
    const group = crypto.randomUUID();
    const a = await order(c.id, group);
    const b = await order(c.id, group);

    const results = await Promise.allSettled([
      asSystem(() => unlinkOrder(a.id)),
      asSystem(() => unlinkOrder(b.id)),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        // A serialization abort maps to the honest 409 (#90); nothing rawer may escape.
        expect(r.reason).toBeInstanceOf(HttpError);
        expect([404, 409]).toContain((r.reason as HttpError).status);
      }
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).linkGroupId).toBeNull();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).linkGroupId).toBeNull();
  }, 20_000);
});
