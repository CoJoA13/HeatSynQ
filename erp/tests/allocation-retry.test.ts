import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "../prisma/generated/prisma/client";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { allocateNumber } from "@/server/settings";
import { retryAllocation, ALLOCATION_TRIES } from "@/server/db-errors";
import { createBatch } from "@/server/receipts";
import { HttpError } from "@/server/http";

/**
 * Issue #115 — concurrent allocation under Serializable.
 *
 * `allocateNumber` claims its counter row with `SELECT … FOR UPDATE`, and EVERY production caller
 * allocates inside a Serializable transaction. A transaction whose snapshot was fixed before that
 * claim aborts with 40001 the moment another allocation commits, and before this fix nothing
 * retried: of N concurrent saves exactly ONE succeeded and the other N-1 failed outright.
 *
 * ⚠️ THE TRAP THAT HID THIS FOR FIVE PHASES: vitest's default isolation is Read Committed, where the
 * claim merely BLOCKS and re-reads. A test that opens its transactions at the default isolation
 * passes while production fails — `allocate-number.test.ts`'s burst test is exactly that shape and
 * says so. **Every transaction in this file names Serializable explicitly.**
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const KEY = "order_number_next";

/** A gate row to block on. Any row this transaction does not otherwise care about will do — it
 *  exists only to hold the racer still at a chosen point. */
async function gateRow(): Promise<string> {
  const c = await prisma.customer.create({ data: { code: "GATE", name: "Gate" } });
  return c.id;
}

/**
 * One allocation shaped like a real caller, pausable at exactly the dangerous point.
 *
 * It reads first (fixing its Serializable snapshot), then blocks on `gatedId`'s row lock, and only
 * then allocates. Holding that row from a SEPARATE Read Committed transaction therefore parks this
 * one AFTER its snapshot is fixed and BEFORE its claim — the `close-periods.ts` dangerous-direction
 * technique. That is what makes the abort below deterministic rather than a hope about timing.
 */
function gatedAllocation(gatedId: string): () => Promise<number> {
  return () => prisma.$transaction(async (tx) => {
    await tx.customer.count(); // fixes the snapshot BEFORE the claim — what every real caller does
    await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${gatedId} FOR UPDATE`;
    return allocateNumber(KEY, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 });
}

/** Holds `gatedId` `FOR UPDATE` until released. Read Committed on purpose: the gate must park the
 *  racer without itself forming an SSI edge, so the ONLY structure under test is
 *  snapshot-then-claim. Returns once the row is actually held. */
async function openGate(gatedId: string): Promise<{ release: () => Promise<void> }> {
  let ready!: () => void;
  const held = new Promise<void>((r) => { ready = r; });
  let releaseIt!: () => void;
  const releaseSignal = new Promise<void>((r) => { releaseIt = r; });

  const tx = prisma.$transaction(async (t) => {
    await t.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${gatedId} FOR UPDATE`;
    ready();
    await releaseSignal;
  }, { timeout: 20000 });

  await held;
  return { release: async () => { releaseIt(); await tx; } };
}

/** A committed competing allocation — the other clerk's save landing while ours is parked. */
async function competingAllocation(): Promise<number> {
  return prisma.$transaction((tx) => allocateNumber(KEY, tx),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function isSerializationAbort(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const raw = (err.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined)
    ?.driverAdapterError?.cause?.originalCode;
  return err.code === "P2034" || raw === "40001";
}

describe("allocateNumber under Serializable (#115)", () => {
  beforeEach(truncateAll);

  /**
   * THE DANGEROUS DIRECTION. This documents WHY the retry exists, so it asserts the hazard is still
   * there at the raw layer. If a future change makes an un-retried allocation stop aborting, this
   * goes red and whoever did it has to come back here and re-read the reasoning rather than quietly
   * deleting a wrapper that looks redundant.
   */
  it("aborts with 40001 when a competing allocation commits after its snapshot — unretried", async () => {
    const gatedId = await gateRow();
    const gate = await openGate(gatedId);

    // Park a real-shaped allocation after its snapshot, before its claim.
    const parked = gatedAllocation(gatedId)().then(() => "resolved" as const, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200));

    // The competitor commits while it is parked — it does NOT touch the gated row, so it runs free.
    expect(await competingAllocation()).toBe(1000);

    await gate.release();
    const outcome = await parked;

    expect(outcome).not.toBe("resolved");
    expect(isSerializationAbort(outcome)).toBe(true);
  });

  /** The same interleaving, wrapped. The re-run gets a snapshot that SEES the competitor's commit
   *  and takes the next number — no 409, nothing for the user to resubmit. */
  it("retryAllocation absorbs that abort and takes the next number", async () => {
    const gatedId = await gateRow();
    const gate = await openGate(gatedId);

    const parked = retryAllocation(gatedAllocation(gatedId))
      .then((n) => n, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200));

    expect(await competingAllocation()).toBe(1000);

    await gate.release();
    expect(await parked).toBe(1001); // not an error, and not a duplicate of the competitor's number

    const row = await prisma.setting.findUnique({ where: { key: KEY } });
    expect(row?.value).toBe(1002); // exactly two numbers consumed — no gap, no reissue
  });

  it("does not retry a business refusal — an HttpError surfaces on the first attempt", async () => {
    let attempts = 0;
    await expect(retryAllocation(async () => {
      attempts += 1;
      throw new HttpError(400, "That customer is inactive");
    })).rejects.toMatchObject({ status: 400 });
    expect(attempts).toBe(1);
  });

  // Bite-proof: the wrapper must actually be bounded, or "it retries" would be indistinguishable
  // from "it loops forever" and the test above proves nothing about the ceiling.
  it("gives up after ALLOCATION_TRIES attempts on a conflict that never clears", async () => {
    let attempts = 0;
    const alwaysConflicts = async () => {
      attempts += 1;
      throw new Prisma.PrismaClientKnownRequestError("aborted", { code: "P2034", clientVersion: "test" });
    };
    await expect(retryAllocation(alwaysConflicts)).rejects.toMatchObject({ code: "P2034" });
    expect(attempts).toBe(ALLOCATION_TRIES);
    expect(ALLOCATION_TRIES).toBeGreaterThan(5); // the measured 1–5-user margin (see db-errors.ts)
  });
});

/**
 * Production shape, through a real caller. `createBatch` is the cheapest of the eight allocating
 * entry points — it needs no fixtures at all — so it is where the end-to-end contract is pinned:
 * N concurrent saves ALL succeed, with distinct, contiguous numbers.
 *
 * Supplementary rather than deterministic (the `certs.test.ts` shape): it fires without awaiting
 * between starts, so real overlap is likely but not guaranteed. The deterministic proof is the
 * gated pair above. What this adds is that the wrapper is actually WIRED INTO a caller — the gated
 * tests would stay green if every service still allocated bare.
 */
describe("createBatch: concurrent allocation through a real caller (#115)", () => {
  beforeEach(truncateAll);

  it("five concurrent batches all succeed with distinct, contiguous numbers", async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        asSystem(() => createBatch({ depositDate: "2026-08-08", controlTotal: null, notes: `b${i}` }))),
    );

    // Named rejections, not a count — a failure here must say WHAT failed.
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.map((r) => String(r.reason))).toEqual([]);

    const numbers = settled
      .map((r) => (r as PromiseFulfilledResult<{ batchNumber: number }>).value.batchNumber)
      .sort((a, b) => a - b);
    expect(numbers).toEqual([1000, 1001, 1002, 1003, 1004]);
    expect(await prisma.receiptBatch.count()).toBe(5);
  });
});
