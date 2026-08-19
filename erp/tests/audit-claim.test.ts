import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { auditedUpdate } from "@/server/audit";
import { updateCustomer } from "@/server/customers";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** Keys whose values differ between an entry's before and after snapshots, sorted. `updatedAt`
 *  legitimately appears in every set (Prisma's @updatedAt bumps on any write) — asserting the
 *  EXACT set, updatedAt included, is what makes "diffs exactly its own field" airtight. */
function changedKeys(entry: { before: unknown; after: unknown }): string[] {
  const before = entry.before as Record<string, unknown>;
  const after = entry.after as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}

// ============================================================================================
// Issue #9 — auditedUpdate reads its before-snapshot, runs doIt, reads its after-snapshot. A
// concurrent committed write to the SAME row lands inside the after-snapshot, so each entry's
// diff absorbs the other edit's field — history then attributes B's change to A. The fix is the
// FOR UPDATE claim at the top of auditedUpdate/auditedSoftDelete, before the before-snapshot:
// whoever claims first holds the row until commit, so the loser's ENTIRE snapshot window (both
// snapshots and the write between them) sees a settled row.
//
// Both tests are DETERMINISTIC, never racing (the house doctrine): test 1 parks transaction A
// inside doIt on a deferred, so B's complete run is forced into A's snapshot window — the exact
// dangerous interleaving, every run. Test 2 is the service-level corroboration; post-fix its
// assertion holds under ANY interleaving, which is the point.
//
// Isolation: vitest transactions here default to Read Committed. That is FINE for this test —
// the row claim is the guard at ANY isolation (CLAUDE.md's row-locks rule; SSI is never what's
// being relied on here). Serializable callers of audited* see the same claim as a locking read
// whose 40001 their existing retry wrappers already handle.
//
// House rules restated: both racers use the real helpers/services, never paraphrases; fixtures
// are raw prisma; promises attach their handlers immediately so an early rejection never
// becomes an unhandled rejection; parked transactions carry a 20000ms timeout.
// ============================================================================================

describe("audit row claim — concurrent edits never absorb each other's diff (#9)", () => {
  beforeEach(truncateAll);

  it("unit: a complete auditedUpdate committing inside a parked one's snapshot window leaves both diffs single-field", async () => {
    const customer = await prisma.customer.create({
      data: { code: "ACME", name: "Acme Gear", defaultPo: "PO-ORIG" },
    });

    let parked!: () => void;
    const parkedP = new Promise<void>((r) => { parked = r; });
    let release!: () => void;
    const releaseP = new Promise<void>((r) => { release = r; });

    // Transaction A: enters auditedUpdate (claim + before-snapshot run), then doIt parks on the
    // deferred BEFORE its own write — holding the snapshot window open. Handlers attached
    // immediately.
    const a = asSystem(() => prisma.$transaction(async (tx) => {
      await auditedUpdate("customer", customer.id, async () => {
        parked();
        await releaseP;
        await tx.customer.update({ where: { id: customer.id }, data: { name: "Acme Heat Treat" } });
      }, { tx });
    }, { timeout: 20000 })).then(() => "resolved" as const, (e: unknown) => e);
    await parkedP;

    // Transaction B: a COMPLETE auditedUpdate patching a DIFFERENT field of the same row.
    // Pre-fix it commits mid-A (nothing blocks it — A has only read so far) and A's
    // after-snapshot absorbs its defaultPo. Post-fix it blocks at the claim until A settles.
    const b = asSystem(() => prisma.$transaction(async (tx) => {
      await auditedUpdate("customer", customer.id, async () => {
        await tx.customer.update({ where: { id: customer.id }, data: { defaultPo: "PO-B" } });
      }, { tx });
    }, { timeout: 20000 })).then(() => "resolved" as const, (e: unknown) => e);

    // Let B run to commit (pre-fix) or to the claim, where it blocks (post-fix). The sleep is
    // generosity, not the guard: post-fix the assertion holds under ANY interleaving, because B
    // cannot enter its snapshot window while A holds the claim.
    await new Promise((r) => setTimeout(r, 200));

    release();
    expect(await a).toBe("resolved");
    expect(await b).toBe("resolved");

    const entries = await prisma.auditLog.findMany({
      where: { entity: "customer", entityId: customer.id, action: "update" },
    });
    expect(entries).toHaveLength(2);
    // A's entry is the one whose diff carries the rename; identification works pre- and
    // post-fix (B never writes `name`, and A parks before writing, so B's entry can't diff it).
    const aEntry = entries.find((e) => (e.after as { name: string }).name === "Acme Heat Treat"
      && (e.before as { name: string }).name === "Acme Gear")!;
    expect(aEntry).toBeDefined();
    const bEntry = entries.find((e) => e.id !== aEntry.id)!;

    // THE INVARIANT: each entry's before/after differ in exactly its own field (+ updatedAt).
    // Pre-fix, A's set is ["defaultPo", "name", "updatedAt"] — B's committed defaultPo landed
    // inside A's after-snapshot, attributing B's change to A.
    expect(changedKeys(aEntry)).toEqual(["name", "updatedAt"]);
    expect(changedKeys(bEntry)).toEqual(["defaultPo", "updatedAt"]);
  });

  it("service: two concurrent updateCustomer calls patching different fields each audit exactly their own field", async () => {
    const customer = await prisma.customer.create({
      data: { code: "ACME", name: "Acme Gear", defaultPo: "PO-ORIG" },
    });

    await Promise.all([
      asSystem(() => updateCustomer(customer.id, { name: "Acme Heat Treat" })),
      asSystem(() => updateCustomer(customer.id, { defaultPo: "PO-B" })),
    ]);

    // Both writes landed…
    const row = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.name).toBe("Acme Heat Treat");
    expect(row.defaultPo).toBe("PO-B");

    // …and whichever order they serialized in, each entry diffs exactly one field. The claim is
    // what makes this hold under any interleaving: the second updater's whole snapshot window
    // waits for the first to commit.
    const entries = await prisma.auditLog.findMany({
      where: { entity: "customer", entityId: customer.id, action: "update" },
    });
    expect(entries).toHaveLength(2);
    const sets = entries.map(changedKeys).sort((x, y) => x[0].localeCompare(y[0]));
    expect(sets).toEqual([["defaultPo", "updatedAt"], ["name", "updatedAt"]]);
  });
});
