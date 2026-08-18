import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createQuote, attachPart } from "@/server/quotes";
import { deleteCustomer } from "@/server/customers";
import { deletePart } from "@/server/parts";
import { HttpError } from "@/server/errors";

// ============================================================================================
// Issue #95 — dangerous-direction tripwires for the two delete-vs-quote-writer SSI pairings
// (Phase 6 spec §4.2's guards; the customers.ts / parts.ts F-comment blocks state each pairing):
//
//   A. deleteCustomer's live-quote count   ↔  createQuote's in-tx customer liveness read
//   B. deletePart's live-quote-line count  ↔  attachPart's in-tx part liveness read
//
// Both invariants hold TODAY because BOTH sides run Serializable with their guard read and
// their write inside ONE transaction — Postgres SSI aborts whichever side would produce a
// state no serial order could (a live quote on a soft-deleted customer; a live quote line on a
// soft-deleted part). Nothing pins that but the isolation level, and CLAUDE.md's standing
// warning is that a downgrade breaks it SILENTLY: SSI tracks only transactions that are ALL
// Serializable, so a Read Committed competitor simply leaves SSI's view and both sides commit.
// These tests turn that silent break into a red run.
//
// Determinism is the close-periods GATE technique (close-periods.test.ts's origin note;
// quote-links.test.ts and template-assignments.test.ts carry the same shape): a Read Committed
// gate transaction holds a row the racer must claim FOR UPDATE, so the REAL racer fixes its
// Serializable snapshot and then BLOCKS — after its liveness read (A) or before it with the
// snapshot already fixed (B) — while the REAL delete commits. The gate is Read Committed ON
// PURPOSE: it must hold the row without forming any SSI edge of its own. House rules that bit
// before, restated: both racers are the real service functions, never paraphrases; fixtures
// are raw prisma (the orders.test.ts rule); the blocked racer's promise attaches its handlers
// IMMEDIATELY so an early rejection never becomes an unhandled rejection; gate transactions
// carry a 20000ms timeout; never vi.spyOn a Prisma delegate.
// ============================================================================================

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("quote-delete races — the §4.2 delete-vs-writer SSI tripwires (#95)", () => {
  beforeEach(async () => { await truncateAll(); });

  // -----------------------------------------------------------------------------------------
  // A — deleteCustomer ↔ createQuote (customers.ts's quote-count guard, quotes.ts's in-tx
  // customer liveness read).
  //
  // GATE: Read Committed, holds the `quote_number_next` Setting row FOR UPDATE. The counter
  // row must EXIST for the gate to grip it — after truncateAll, `allocateNumber` would
  // otherwise find no row to FOR-UPDATE, never block, and the create would commit before the
  // delete even starts (the quote-links.test.ts trap). The quote's line is FREE-TEXT only, so
  // `resolveQuoteLines` reads no Part rows and deleteCustomer's (unrelated, earlier) parts
  // guard stays at zero — it is unambiguously the quotes guard racing here (the
  // customers.test.ts `quoteFor` fixture shape).
  //
  // SEQUENCE: createQuote fixes its Serializable snapshot at its customer read (sees the
  // customer LIVE), then blocks at allocateNumber's SELECT … FOR UPDATE on the gated counter —
  // paused after its guard read, before its writes. The REAL deleteCustomer commits meanwhile:
  // its quote count reads ZERO (the quote isn't written yet), every guard passes, the customer
  // is soft-deleted. Gate released, the create proceeds on its stale snapshot into the SSI
  // abort (40001): its customer read is a rw-antidependency out to the delete's customer
  // write, and the delete's quote-count predicate read is one back in to the create's quote
  // insert — a cycle no serial order produces, and the delete already committed, so the create
  // is the one shot.
  //
  // The #115 wrinkle: createQuote wraps its transaction in `retryAllocation`, so the 40001 is
  // ABSORBED, never surfaced as a 409 — the re-run's fresh snapshot sees the customer dead and
  // answers 400 "That customer does not exist", the same answer a caller arriving a moment
  // later would get. The status is informative, but the INVARIANT is the assertion: zero live
  // quotes point at the customer, and the customer is soft-deleted.
  //
  // RED procedure (run it, watch it, restore it — never commit it): pin deleteCustomer's
  // `$transaction` (customers.ts) to `isolationLevel: ReadCommitted`. The soft-delete leaves
  // SSI's view, nothing aborts the still-Serializable create, and BOTH commit: `outcome` comes
  // back "resolved" with one live quote on the soft-deleted customer — exactly the orphan the
  // guard exists to prevent. Observed red 2026-08-18; transcript in the task 7 report.
  //
  // ⚠️ THE IMMUTABILITY DEPENDENCY, which no isolation level covers: the guard counts rows
  // whose `customerId` can never change, because updateQuote refuses re-points outright ("The
  // customer on a quote cannot be changed — delete this quote and enter a new one", quotes.ts).
  // Relax that refusal and an updateQuote re-point lands a quote on a just-counted customer
  // WITHOUT any race at all — and a header-only updateQuote payload doesn't even run
  // Serializable (`assignsFk` gates the isolation: only a payload carrying lines or an ending
  // statement upgrades), so there would be no SSI edge to abort. The refusal is load-bearing
  // for this guard, not a UX nicety.
  // -----------------------------------------------------------------------------------------
  it("a createQuote whose snapshot predates a committed deleteCustomer aborts and re-judges — no live quote lands on the dead customer", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
    const user = await prisma.user.create({
      data: { username: "qdr-user", passwordHash: "x", displayName: "QDR User" },
    });
    // The counter row the gate grips — see the trap note above.
    await prisma.setting.create({ data: { key: "quote_number_next", value: 1000 } });

    let gateHeld!: () => void;
    const held = new Promise<void>((r) => { gateHeld = r; });
    let releaseGate!: () => void;
    const gateRelease = new Promise<void>((r) => { releaseGate = r; });

    // The GATE: Read Committed, holds the quote-number counter row, forms no SSI edge.
    const gate = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "key" FROM "Setting" WHERE "key" = 'quote_number_next' FOR UPDATE`;
      gateHeld();
      await gateRelease;
    }, { timeout: 20000 });
    await held;

    // The REAL createQuote: free-text line only; quotedById named explicitly because the
    // system actor has no id and Quote.quotedById is NOT NULL. Handlers attached immediately.
    const create = asSystem(() => createQuote({
      customerId: customer.id, quotedById: user.id,
      lines: [{ partNumberText: "FT-1" }],
    })).then(() => "resolved" as const, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200)); // let it read the customer + block on the counter

    // The REAL deleteCustomer commits while the create is paused: quote count 0, guard passes.
    await asSystem(() => deleteCustomer(customer.id, "closed shop"));
    const dead = await prisma.customer.findFirst({ where: { id: customer.id } });
    expect(dead?.deletedAt).not.toBeNull();

    releaseGate();
    await gate;

    // Attempt 1 aborts 40001 (absorbed by retryAllocation); attempt 2's fresh snapshot sees
    // the customer dead → 400. The request must NOT have resolved.
    const outcome = await create;
    expect(outcome).not.toBe("resolved");
    expect(outcome).toBeInstanceOf(HttpError);
    expect((outcome as HttpError).status).toBe(400);
    expect((outcome as HttpError).message).toBe("That customer does not exist");

    // THE INVARIANT: no live quote points at the soft-deleted customer — in fact nothing was
    // written at all, both attempts having rolled back whole.
    expect(await prisma.quote.count({ where: { customerId: customer.id, deletedAt: null } })).toBe(0);
    expect(await prisma.quote.count()).toBe(0);
    // ...and the failed save consumed no number (the pinned allocation contract): attempt 1
    // rolled back its counter bump, attempt 2 threw before ever reaching allocateNumber.
    const counter = await prisma.setting.findUniqueOrThrow({ where: { key: "quote_number_next" } });
    expect(counter.value).toBe(1000);
  });

  // -----------------------------------------------------------------------------------------
  // B — deletePart ↔ attachPart (parts.ts's quote-line-count guard, attachPart's in-tx part
  // liveness read).
  //
  // GATE: Read Committed, holds the QUOTE row FOR UPDATE. attachPart's FIRST statement is
  // claimQuote's SELECT … FOR UPDATE on that row, so it fixes its Serializable snapshot there
  // and blocks BEFORE its part read — when it finally runs, that read still sees the part LIVE
  // from the pre-delete snapshot, so the clean 400 ("That part does not exist") deliberately
  // does NOT fire; only SSI stops the write, at commit (the template-assignments.test.ts
  // dangerous-direction shape).
  //
  // SEQUENCE: the REAL deletePart commits while the attach is paused — its live-quote-line
  // count reads ZERO (the line is still free-text), the live-order guard likewise, so the part
  // is soft-deleted. Gate released, attachPart writes QuoteLine.partId on the stale snapshot
  // and SSI aborts it: the part read is a rw-antidependency out to the delete's part write,
  // and the delete's quote-line predicate read is one back in to the attach's partId write.
  // attachPart has NO retry wrapper (it allocates nothing), so the abort SURFACES: P2034 →
  // withDbErrors → HttpError 409, the retryable "try again" — and a caller who does try again
  // gets the clean 400, the part now dead in its fresh snapshot.
  //
  // RED procedure (run it, watch it, restore it — never commit it): pin deletePart's
  // `$transaction` (parts.ts) to `isolationLevel: ReadCommitted`. The delete leaves SSI's
  // view, the still-Serializable attach commits, and a live quote line carries a soft-deleted
  // part — `outcome` comes back "resolved", the live-line count 1. Observed red 2026-08-18;
  // transcript in the task 7 report.
  // -----------------------------------------------------------------------------------------
  it("an attachPart whose snapshot predates a committed deletePart is aborted 409 — no live quote line carries the dead part", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
    const user = await prisma.user.create({
      data: { username: "qdr-user", passwordHash: "x", displayName: "QDR User" },
    });
    // The part: same customer as the quote (attachPart's ownership check), referenced by NO
    // live order line and NO live quote line, so both of deletePart's guards read zero.
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-100", eachWeight: "1.0000" },
    });
    // A live OPEN quote with one FREE-TEXT line — the row attachPart will claim.
    const quote = await prisma.quote.create({
      data: {
        quoteNumber: 1200, customerId: customer.id, quotedById: user.id,
        quoteDate: new Date("2026-08-01"), effectiveDate: new Date("2026-08-01"),
        expiryDate: new Date("2026-12-31"),
        lines: { create: [{ position: 1, partNumberText: "FT-1" }] },
      },
      include: { lines: true },
    });
    const line = quote.lines[0];

    let gateHeld!: () => void;
    const held = new Promise<void>((r) => { gateHeld = r; });
    let releaseGate!: () => void;
    const gateRelease = new Promise<void>((r) => { releaseGate = r; });

    // The GATE: Read Committed, holds the quote row attachPart must claim first.
    const gate = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Quote" WHERE "id" = ${quote.id} FOR UPDATE`;
      gateHeld();
      await gateRelease;
    }, { timeout: 20000 });
    await held;

    // The REAL attachPart: snapshot fixes at claimQuote's FOR UPDATE, where it blocks — before
    // its part read. Handlers attached immediately.
    const attach = asSystem(() => attachPart(quote.id, { lineId: line.id, partId: part.id }))
      .then(() => "resolved" as const, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200)); // let it fix its snapshot + block on the quote row

    // The REAL deletePart commits while the attach is paused: zero live references, guards pass.
    await asSystem(() => deletePart(part.id, "obsolete casting"));
    const deadPart = await prisma.part.findFirst({ where: { id: part.id } });
    expect(deadPart?.deletedAt).not.toBeNull();

    releaseGate();
    await gate;

    // SSI serialization-abort, surfaced (no retry wrapper): the retryable 409.
    const outcome = await attach;
    expect(outcome).not.toBe("resolved");
    expect(outcome).toBeInstanceOf(HttpError);
    expect((outcome as HttpError).status).toBe(409);

    // THE INVARIANT: no live quote line carries the soft-deleted part — the attach never landed.
    expect(await prisma.quoteLine.count({ where: { partId: part.id, deletedAt: null } })).toBe(0);
    const after = await prisma.quoteLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(after.partId).toBeNull();
  });
});
