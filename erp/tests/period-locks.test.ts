import { beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { finalizeInvoice } from "@/server/invoices";
import { createBatch, addPayment, postBatch } from "@/server/receipts";
import { parseDateOnly, todayDateOnly } from "@/lib/business-days";
import {
  assertPeriodOpen, closedMonthsForDisplay, closedPeriodFor, lockMonth, monthKey, periodLabel,
} from "@/server/period-locks";
import type { Prisma } from "../prisma/generated/prisma/client";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

beforeEach(truncateAll);

/** Every .ts/.tsx under a directory — the `partial-unique-sweep.test.ts` walk, copied rather than
 *  shared because that file's copy is itself private to it. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [full] : [];
  });
}

async function closeMonth(year: number, month: number) {
  return prisma.closePeriod.create({
    data: { year, month, beginningAr: 0, invoicedTotal: 0, creditTotal: 0, paymentTotal: 0,
      discountTotal: 0, writeOffTotal: 0, endingAr: 0, agingEndingAr: 0 },
  });
}

// ---------------------------------------------------------------------------------------------
// Step 1: the guard itself.
// ---------------------------------------------------------------------------------------------

it("refuses a date inside a CLOSED month, allows an open month", async () => {
  await closeMonth(2026, 7);
  await prisma.$transaction(async (tx) => {
    await expect(assertPeriodOpen(tx, new Date("2026-07-15"))).rejects.toThrow(/closed/i);
    await assertPeriodOpen(tx, new Date("2026-08-01")); // no throw
  });
});

it("a REOPENED month is open again", async () => {
  const p = await closeMonth(2026, 7);
  await prisma.closePeriod.update({ where: { id: p.id }, data: { status: "REOPENED" } });
  await prisma.$transaction(async (tx) => {
    await assertPeriodOpen(tx, new Date("2026-07-15")); // no throw
    expect(await closedPeriodFor(tx, new Date("2026-07-15"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Step 4: the leaf really is a leaf — the invoice-guards.ts import-shape pin, applied here.
// ---------------------------------------------------------------------------------------------

it("stays a dependency-free leaf", () => {
  const src = readFileSync(new URL("../src/server/period-locks.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/from ["']\.\/(invoices|receipts|applications|orders|shippers|close-periods|gl-export)["']/);
  expect(src).not.toMatch(/\brequire\(|import\(/);
});

// ---------------------------------------------------------------------------------------------
// Step 7a: the guard is WIRED into the real finalize path. RED-verified by deleting the
// `assertPeriodOpen(tx, todayDateOnly())` call in `finalizeInvoiceInTx` — the invoice then
// finalizes clean and this test fails to throw (transcript in task-4-report.md). The invoice is
// built raw (the applications-concurrency.test.ts pattern): a zero-line DRAFT reaches the guard
// through finalize's only pre-guard block (`needsPrice`), and with no lines and no customer terms it
// also finalizes cleanly once the guard is removed, so the RED run resolves rather than throwing
// some unrelated error.
//
// Ruling 8: finalize recognizes an invoice in its FINALIZE month, so the guard is on TODAY, not the
// document `invoiceDate`. The refusal test therefore closes TODAY's month; the no-op test closes a
// DIFFERENT month and finalizes into today (open).
// ---------------------------------------------------------------------------------------------

let seq = 0;
async function draftInvoiceDated(dateStr: string): Promise<string> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `PC${seq}`, name: `Period Customer ${seq}` } });
  const order = await prisma.order.create({
    data: {
      orderNumber: 720000 + seq, customerId: customer.id, status: "SHIPPED",
      receivedDate: parseDateOnly("2026-07-01"), requestDate: parseDateOnly("2026-07-01"),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      kind: "INVOICE", status: "DRAFT", orderId: order.id, customerId: customer.id,
      invoiceDate: parseDateOnly(dateStr),
      // One line, because #63 refuses to finalize an invoice with none — and these tests are about
      // the PERIOD guard, so the invoice has to reach it.
      lines: { create: [{ position: 1, kind: "OPERATION", description: "Austemper", amount: 0 }] },
    },
  });
  return invoice.id;
}

it("refuses finalizing when the finalize month (today) is closed — ruling 8", async () => {
  // The document date is irrelevant to the guard now — a July-dated draft finalized today is refused
  // iff TODAY's month is closed. Close today's month and prove the finalize is refused.
  const invoiceId = await draftInvoiceDated("2026-07-10");
  const today = todayDateOnly();
  await closeMonth(today.getUTCFullYear(), today.getUTCMonth() + 1);
  await expect(asSystem(() => finalizeInvoice(invoiceId))).rejects.toThrow(/closed/i);
  // Refused, not half-applied: the invoice is still a DRAFT.
  expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("DRAFT");
});

it("finalizes normally when the finalize month (today) is open, even though a DIFFERENT month is closed", async () => {
  const invoiceId = await draftInvoiceDated("2026-08-10");
  await closeMonth(2020, 1); // a clearly different (past) month is closed — today's month stays open
  const done = await asSystem(() => finalizeInvoice(invoiceId));
  expect(done.status).toBe("FINALIZED");
});

// ---------------------------------------------------------------------------------------------
// #157: `closedMonthsForDisplay` — the LOCK-FREE sibling. Three properties are pinned here, and the
// third is the one that matters for safety: the lock-free read must not have quietly become the way
// `assertPeriodOpen` answers its question.
// ---------------------------------------------------------------------------------------------

describe("closedMonthsForDisplay — the display read (#157)", () => {
  it("returns only CLOSED months among the dates asked about, keyed by monthKey", async () => {
    await closeMonth(2026, 7);
    await closeMonth(2026, 5);          // closed, but never asked about below
    const reopened = await closeMonth(2026, 6);
    await prisma.closePeriod.update({ where: { id: reopened.id }, data: { status: "REOPENED" } });

    const closed = await closedMonthsForDisplay(prisma, [
      new Date("2026-06-15"), // REOPENED — open again (§4.1)
      new Date("2026-07-01"), // CLOSED
      new Date("2026-08-31"), // no row at all
    ]);
    expect([...closed.keys()]).toEqual([monthKey(new Date("2026-07-15"))]);
    expect(closed.get(202607)).toMatchObject({ year: 2026, month: 7 });
    expect(closed.has(202605)).toBe(false); // a closed month nobody asked about is not volunteered
  });

  it("answers an empty date list without touching the database", async () => {
    // `finalizedInvoicesFor`'s "without touching the database" pin: a client that would throw on any
    // access proves the early return is real and not merely fast.
    const explodes = new Proxy({}, { get() { throw new Error("queried the database"); } });
    expect(await closedMonthsForDisplay(explodes as Prisma.TransactionClient, [])).toEqual(new Map());
  });

  it("issues ONE query for the DISTINCT months, however many dates it is handed", async () => {
    // The retention branch runs inside a loop over invoices; one query per row is the shape this
    // exists to avoid, and only a call recorder can see the difference.
    const calls: unknown[] = [];
    const recorder = {
      closePeriod: {
        findMany: async (args: unknown) => { calls.push(args); return []; },
      },
    } as unknown as Prisma.TransactionClient;

    await closedMonthsForDisplay(recorder, [
      new Date("2026-07-01"), new Date("2026-07-15"), new Date("2026-07-31"), // one month
      new Date("2026-08-02"),
      new Date("2025-12-31"),
    ]);
    expect(calls).toHaveLength(1);
    // Order-INDEPENDENT: the contract is "one query, each distinct month exactly once", and the
    // order the `OR` arms come out in is an artefact of how the dates were handed in. Pinning it
    // would couple this test to something the function does not promise.
    const or = (calls[0] as { where: { OR: unknown[] } }).where.OR;
    expect(or).toHaveLength(3);
    expect(or).toEqual(expect.arrayContaining([
      { year: 2026, month: 7 }, { year: 2026, month: 8 }, { year: 2025, month: 12 },
    ]));
  });

  it("labels a month the way the refusal does", () => {
    expect(periodLabel({ year: 2026, month: 8 })).toBe("2026-08");
  });

  // THE SAFETY PIN. `closedMonthsForDisplay` must take no month lock (so a customer page cannot be
  // serialized behind a running close), and `assertPeriodOpen` must still take one (so the period
  // lock's standing invariant survives). Both halves in ONE test, against a held lock, because the
  // pair is the property — a lock-free guard is the failure this file exists to prevent.
  //
  // RED-VERIFIED both ways: adding `await lockMonth(db, …)` to `closedMonthsForDisplay` hangs the
  // display half; routing `assertPeriodOpen` at `closedMonthsForDisplay` instead of
  // `closedPeriodFor` makes `guardBlockedWhileHeld` read false.
  it("takes NO month lock, while assertPeriodOpen still does", async () => {
    // A month closed BEFORE the lock is taken, and in a DIFFERENT month from the one held — so the
    // display half below can assert the read is still CORRECT under a held lock, not merely that it
    // returned. "It answered" and "it answered right" are different properties, and a lock-free read
    // that started returning an empty map would pass the weaker one.
    await closeMonth(2026, 5);

    let hasLock!: () => void;
    const locked = new Promise<void>((r) => { hasLock = r; });
    let release!: () => void;
    const mayRelease = new Promise<void>((r) => { release = r; });

    const holder = prisma.$transaction(async (tx) => {
      await lockMonth(tx, 2026, 7);
      hasLock();
      await mayRelease;
    }, { timeout: 15000 });
    await locked;

    // The display read completes while the month lock is held by someone else — and answers
    // correctly: 2026-05 is closed, the held 2026-07 is not.
    const displayed = await closedMonthsForDisplay(prisma, [
      new Date("2026-05-20"), new Date("2026-07-15"),
    ]);
    expect([...displayed.keys()]).toEqual([monthKey(new Date("2026-05-20"))]);

    // The GUARD does not: it blocks on the same lock until the holder commits.
    let guardDone = false;
    const guard = prisma.$transaction(async (tx) => {
      await assertPeriodOpen(tx, new Date("2026-07-15"));
      guardDone = true;
    }, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 200));
    const guardBlockedWhileHeld = !guardDone;

    release();
    await holder;
    await guard;

    expect(guardBlockedWhileHeld).toBe(true);
    expect(guardDone).toBe(true);
  });

  // The OTHER half of the safety property, and the likelier future mistake. The test above catches
  // `assertPeriodOpen` being re-routed through the lock-free read; it cannot see a NEW mutation
  // importing `closedMonthsForDisplay` directly instead of `assertPeriodOpen` — which is the same
  // breach arriving by the front door. The docblock says "never a guard"; this makes a third caller
  // a decision rather than a convenience.
  //
  // An ALLOWLIST, the `invoice-guards` leaf-test and `audit-children`'s INVALIDATION_SITES idiom:
  // both sanctioned callers are page/wording reads that permit nothing.
  it("is imported by exactly the two callers that only DISPLAY it", () => {
    const src = join(process.cwd(), "src");
    const importers = tsFiles(src)
      .map((f) => f.slice(src.length + 1))
      // Any MENTION, not just an `import { … }` line — a namespace import, a re-export or a
      // dynamic import would all reach it, and this errs deliberately toward over-sensitive: the
      // property being protected is the period lock's standing invariant, so a name-drop in a
      // comment failing loudly is the cheap direction to be wrong in. `period-locks.ts` itself is
      // excluded because it DECLARES the function; every other file here consumes it.
      .filter((f) => f !== join("server", "period-locks.ts"))
      .filter((f) => /\bclosedMonthsForDisplay\b/.test(readFileSync(join(src, f), "utf8")))
      .sort();
    expect(importers).toEqual([
      // The customer A/R section's retention branch — a pure page read (#157).
      "server/applications.ts",
      // Chooses the WORDING of a refusal already decided by `hasReceivableActivity`; permits nothing.
      "server/invoice-guards.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Step 7b: prove the load-bearing mechanism — `lockMonth` takes a REAL transaction-level advisory
// lock that serializes two transactions on the same month, which no plain `findFirst` could. This is
// the phantom-closing lock the guard and Task 5's close both rely on (the finalize-vs-close race
// itself is Task 5's to integration-test, since `closePeriod` does not exist yet). RED-verified by
// stubbing `lockMonth`'s body to a no-op: B then never blocks and `bLockedWhileAHeld` reads true
// (transcript in task-4-report.md).
// ---------------------------------------------------------------------------------------------

describe("lockMonth advisory lock", () => {
  it("serializes two transactions on the SAME month; a DIFFERENT month does not block", async () => {
    // A takes month 7 and holds it open until we release it.
    let aHasLock!: () => void;
    const aLocked = new Promise<void>((r) => { aHasLock = r; });
    let releaseA!: () => void;
    const aMayRelease = new Promise<void>((r) => { releaseA = r; });

    const txA = prisma.$transaction(async (tx) => {
      await lockMonth(tx, 2026, 7);
      aHasLock();            // A definitely holds month 7 now
      await aMayRelease;     // hold the lock open
    }, { timeout: 15000 });

    await aLocked;

    // A DIFFERENT month is not blocked by A's lock — completes while A still holds month 7.
    let otherMonthDone = false;
    await prisma.$transaction(async (tx) => { await lockMonth(tx, 2026, 8); otherMonthDone = true; });
    expect(otherMonthDone).toBe(true);

    // The SAME month blocks: B cannot take month 7 until A commits.
    let bDone = false;
    const txB = prisma.$transaction(async (tx) => { await lockMonth(tx, 2026, 7); bDone = true; },
      { timeout: 15000 });

    // Give B a window to (wrongly) proceed if the lock were a no-op; it must stay blocked.
    await new Promise((r) => setTimeout(r, 200));
    const bLockedWhileAHeld = bDone;

    releaseA();            // A commits, dropping the xact lock
    await txA;
    await txB;             // B now unblocks and finishes

    expect(bLockedWhileAHeld).toBe(false); // B was blocked the whole time A held month 7
    expect(bDone).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 1 (review finding, ABBA deadlock): `postBatch` must guard EVERY distinct month a
// multi-month batch's payments fall in, not just the first one found — the fix sorts/dedups to
// one advisory-lock call per distinct (year, month), ascending, closing the deadlock window an
// unsorted per-payment loop would open between two batches sharing two months. The ordering
// itself is a concurrency invariant, not something a single-process test can observe; what IS
// testable here is coverage — a closed month anywhere in the batch refuses the whole post, and
// with none closed the post goes through covering every month.
// ---------------------------------------------------------------------------------------------

describe("postBatch — guards every distinct month of a multi-month batch", () => {
  let seq = 0;
  async function batchSpanningTwoMonths(): Promise<string> {
    seq += 1;
    const customer = await prisma.customer.create({
      data: { code: `PLB${seq}`, name: `Period Batch Customer ${seq}` } });
    const paymentType = await prisma.paymentType.create({ data: { name: `Check ${seq}` } });
    const batch = await asSystem(() => createBatch({ depositDate: "2026-07-15", controlTotal: null }));
    await asSystem(() => addPayment(batch.id, {
      customerId: customer.id, paymentTypeId: paymentType.id, amount: 100,
      reference: "a", receivedDate: "2026-06-15",
    }));
    await asSystem(() => addPayment(batch.id, {
      customerId: customer.id, paymentTypeId: paymentType.id, amount: 200,
      reference: "b", receivedDate: "2026-07-15",
    }));
    return batch.id;
  }

  it("refuses postBatch when only the SECOND month of the batch is closed", async () => {
    const batchId = await batchSpanningTwoMonths();
    await closeMonth(2026, 7); // June (the first payment's month) stays open
    await expect(asSystem(() => postBatch(batchId))).rejects.toMatchObject({
      status: 409, message: expect.stringMatching(/2026-07 is closed/),
    });
  });

  it("posts cleanly when neither month is closed", async () => {
    const batchId = await batchSpanningTwoMonths();
    const posted = await asSystem(() => postBatch(batchId));
    expect(posted.status).toBe("POSTED");
  });
});
