import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { eligibleQuoteLines, resolveAutoLink, judgeQuoteLine } from "@/server/quote-links";
import { createOrder, addLine, updateLine, updateOrder, getOrder } from "@/server/orders";
import { updateQuote } from "@/server/quotes";
import { parseDateOnly } from "@/lib/business-days";

// ============================================================================================
// Phase 6 Task 5 — the quote-link eligibility LEAF (spec §5.2, rulings 5–7). Fixtures are raw
// prisma on purpose (the orders.test.ts rule): the leaf under test must not depend on the quote
// service to construct its own data. Dates are fixed literals — eligibility is judged against a
// RECEIVED DATE the test also fixes, so nothing here moves with the clock.
// ============================================================================================

const d = parseDateOnly;

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
  const other = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "P-100", eachWeight: "1.0000" },
  });
  const part2 = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "P-200", eachWeight: "1.0000" },
  });
  const user = await prisma.user.create({
    data: { username: "ql-user", passwordHash: "x", displayName: "QL User" },
  });
  return { customer, other, part, part2, user };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

let quoteSeq = 0;

/** One quote with ONE line, every §5.2 clause independently controllable. */
async function makeQuote(f: Fixture, opts: {
  number?: number;
  customerId?: string;
  effective: string;
  expiry: string;
  status?: "OPEN" | "CLOSED";
  deleted?: boolean;
  line?: { partId?: string | null; deleted?: boolean; partNumberText?: string };
}) {
  quoteSeq += 1;
  const line = opts.line ?? {};
  const quote = await prisma.quote.create({
    data: {
      quoteNumber: opts.number ?? 1000 + quoteSeq,
      customerId: opts.customerId ?? f.customer.id,
      quotedById: f.user.id,
      status: opts.status ?? "OPEN",
      deletedAt: opts.deleted ? new Date() : null,
      quoteDate: d(opts.effective),
      effectiveDate: d(opts.effective),
      expiryDate: d(opts.expiry),
      lines: {
        create: [{
          position: 1,
          partId: line.partId === undefined ? f.part.id : line.partId,
          partNumberText: line.partNumberText ?? "",
          deletedAt: line.deleted ? new Date() : null,
        }],
      },
    },
    include: { lines: true },
  });
  return { quote, line: quote.lines[0] };
}

describe("quote-links: the §5.2 eligibility predicate, clause by clause", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    quoteSeq = 0;
  });

  it("an OPEN, live, in-window quote line for the right customer + part is eligible — full candidate shape", async () => {
    const f = await fixture();
    const { quote, line } = await makeQuote(f, {
      number: 1006, effective: "2026-08-01", expiry: "2026-08-31",
    });

    const args = { customerId: f.customer.id, partId: f.part.id, receivedDate: d("2026-08-15") };
    const expected = {
      quoteLineId: line.id, quoteId: quote.id, quoteNumber: 1006,
      effectiveDate: "2026-08-01", expiryDate: "2026-08-31",
    };
    expect(await eligibleQuoteLines(prisma, args)).toEqual([expected]);
    expect(await resolveAutoLink(prisma, args)).toEqual(expected);
    expect(await judgeQuoteLine(prisma, line.id, args)).toEqual({ ok: true, candidate: expected });
  });

  it("the window is inclusive on BOTH ends — received = effective and received = expiry are both eligible, one day outside either end is not (query AND judge paths)", async () => {
    const f = await fixture();
    const { line } = await makeQuote(f, { effective: "2026-08-10", expiry: "2026-08-20" });
    const args = (received: string) =>
      ({ customerId: f.customer.id, partId: f.part.id, receivedDate: d(received) });

    // Inclusive: the first and last day of the window both link.
    expect(await eligibleQuoteLines(prisma, args("2026-08-10"))).toHaveLength(1);
    expect(await eligibleQuoteLines(prisma, args("2026-08-20"))).toHaveLength(1);
    expect(await judgeQuoteLine(prisma, line.id, args("2026-08-10"))).toMatchObject({ ok: true });
    expect(await judgeQuoteLine(prisma, line.id, args("2026-08-20"))).toMatchObject({ ok: true });

    // Exclusive outside: one day early, one day late.
    expect(await eligibleQuoteLines(prisma, args("2026-08-09"))).toEqual([]);
    expect(await eligibleQuoteLines(prisma, args("2026-08-21"))).toEqual([]);
    expect(await judgeQuoteLine(prisma, line.id, args("2026-08-09"))).toMatchObject({
      ok: false, reason: expect.stringContaining("not in effect on 2026-08-09"),
    });
    expect(await judgeQuoteLine(prisma, line.id, args("2026-08-21"))).toMatchObject({
      ok: false, reason: expect.stringContaining("not in effect on 2026-08-21"),
    });
  });

  it("a CLOSED quote is never eligible — it stops auto-linking AND stops being manually linkable (spec §5.1)", async () => {
    const f = await fixture();
    const { line } = await makeQuote(f, {
      number: 1042, effective: "2026-08-01", expiry: "2026-08-31", status: "CLOSED",
    });
    const args = { customerId: f.customer.id, partId: f.part.id, receivedDate: d("2026-08-15") };

    expect(await eligibleQuoteLines(prisma, args)).toEqual([]);
    expect(await judgeQuoteLine(prisma, line.id, args)).toEqual({
      ok: false, reason: "Quote #1042 is closed",
    });
  });

  it("a soft-deleted quote is never eligible", async () => {
    const f = await fixture();
    const { line } = await makeQuote(f, {
      number: 1043, effective: "2026-08-01", expiry: "2026-08-31", deleted: true,
    });
    const args = { customerId: f.customer.id, partId: f.part.id, receivedDate: d("2026-08-15") };

    expect(await eligibleQuoteLines(prisma, args)).toEqual([]);
    expect(await judgeQuoteLine(prisma, line.id, args)).toEqual({
      ok: false, reason: "Quote #1043 has been deleted",
    });
  });

  it("a soft-deleted quote LINE is never eligible even while its quote is live", async () => {
    const f = await fixture();
    const { line } = await makeQuote(f, {
      number: 1044, effective: "2026-08-01", expiry: "2026-08-31", line: { deleted: true },
    });
    const args = { customerId: f.customer.id, partId: f.part.id, receivedDate: d("2026-08-15") };

    expect(await eligibleQuoteLines(prisma, args)).toEqual([]);
    expect(await judgeQuoteLine(prisma, line.id, args)).toEqual({
      ok: false, reason: "Quote #1044 no longer carries that line",
    });
  });

  it("another customer's quote is never eligible, even over the same part id", async () => {
    const f = await fixture();
    const { line } = await makeQuote(f, {
      number: 1045, customerId: f.other.id, effective: "2026-08-01", expiry: "2026-08-31",
    });
    const args = { customerId: f.customer.id, partId: f.part.id, receivedDate: d("2026-08-15") };

    expect(await eligibleQuoteLines(prisma, args)).toEqual([]);
    expect(await judgeQuoteLine(prisma, line.id, args)).toEqual({
      ok: false, reason: "Quote #1045 belongs to another customer",
    });
  });

  it("a free-text line (partId null) is never eligible until a part is attached (ruling 1)", async () => {
    const f = await fixture();
    const { line } = await makeQuote(f, {
      number: 1046, effective: "2026-08-01", expiry: "2026-08-31",
      line: { partId: null, partNumberText: "FT-1" },
    });
    const args = { customerId: f.customer.id, partId: f.part.id, receivedDate: d("2026-08-15") };

    expect(await eligibleQuoteLines(prisma, args)).toEqual([]);
    expect(await judgeQuoteLine(prisma, line.id, args)).toMatchObject({
      ok: false, reason: expect.stringContaining("free-text"),
    });
  });

  it("a line quoting a DIFFERENT part is not eligible for this one", async () => {
    const f = await fixture();
    const { line } = await makeQuote(f, {
      number: 1047, effective: "2026-08-01", expiry: "2026-08-31", line: { partId: f.part2.id },
    });
    const args = { customerId: f.customer.id, partId: f.part.id, receivedDate: d("2026-08-15") };

    expect(await eligibleQuoteLines(prisma, args)).toEqual([]);
    expect(await judgeQuoteLine(prisma, line.id, args)).toEqual({
      ok: false, reason: "Quote #1047's line quotes a different part",
    });
  });

  it("judgeQuoteLine names an unknown quote line as such", async () => {
    await fixture();
    const f2 = await prisma.customer.findFirstOrThrow();
    expect(await judgeQuoteLine(prisma, "nope", {
      customerId: f2.id, partId: "irrelevant", receivedDate: d("2026-08-15"),
    })).toEqual({ ok: false, reason: "that quote line does not exist" });
  });
});

describe("quote-links: resolveAutoLink ordering (ruling 7)", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    quoteSeq = 0;
  });

  it("latest effective date wins silently among several open in-date quotes", async () => {
    const f = await fixture();
    const early = await makeQuote(f, { number: 1001, effective: "2026-07-01", expiry: "2026-12-31" });
    const latest = await makeQuote(f, { number: 1002, effective: "2026-08-01", expiry: "2026-12-31" });
    const middle = await makeQuote(f, { number: 1003, effective: "2026-07-15", expiry: "2026-12-31" });

    const args = { customerId: f.customer.id, partId: f.part.id, receivedDate: d("2026-08-15") };
    const ordered = await eligibleQuoteLines(prisma, args);
    expect(ordered.map((c) => c.quoteLineId))
      .toEqual([latest.line.id, middle.line.id, early.line.id]);
    expect((await resolveAutoLink(prisma, args))?.quoteLineId).toBe(latest.line.id);
  });

  it("an effective-date tie breaks to the HIGHER quote number", async () => {
    const f = await fixture();
    const lower = await makeQuote(f, { number: 1010, effective: "2026-08-01", expiry: "2026-12-31" });
    const higher = await makeQuote(f, { number: 1011, effective: "2026-08-01", expiry: "2026-12-31" });

    const args = { customerId: f.customer.id, partId: f.part.id, receivedDate: d("2026-08-15") };
    const ordered = await eligibleQuoteLines(prisma, args);
    expect(ordered.map((c) => c.quoteNumber)).toEqual([1011, 1010]);
    expect((await resolveAutoLink(prisma, args))?.quoteLineId).toBe(higher.line.id);
    expect(lower.line.id).not.toBe(higher.line.id);
  });

  it("returns null when no quote covers the line — no link is a normal state, not an error", async () => {
    const f = await fixture();
    await makeQuote(f, { effective: "2026-08-01", expiry: "2026-08-31", status: "CLOSED" });
    expect(await resolveAutoLink(prisma, {
      customerId: f.customer.id, partId: f.part.id, receivedDate: d("2026-08-15"),
    })).toBeNull();
  });
});

// ============================================================================================
// The ORDER side (spec §5.2 "at order save"): three-way `quoteLineId` semantics in
// createOrder/addLine/updateLine, judged-at-link-time survival (ruling 6), the idempotent
// replay, the audit trail, and the §5.14 SSI pairing's dangerous-direction test.
// ============================================================================================

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** The leaf fixture plus everything createOrder demands of its lead part: a step-bearing
 *  revision (the orderability precondition, built raw — the orders.test.ts rule). */
async function orderFixture() {
  const f = await fixture();
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: f.part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
  return { ...f, code };
}
type OrderFixture = Awaited<ReturnType<typeof orderFixture>>;

const line = (partId: string, extra?: Record<string, unknown>) =>
  ({ partId, qty: 10, weight: "100.00", ...extra });

describe("createOrder: the three-way quoteLineId semantics (spec §5.2)", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    quoteSeq = 0;
  });

  it("an ABSENT key auto-resolves latest-effective-wins per line; a line no quote covers stores null", async () => {
    const f = await orderFixture();
    await makeQuote(f, { number: 1001, effective: "2026-07-01", expiry: "2026-12-31" });
    const latest = await makeQuote(f, { number: 1002, effective: "2026-08-01", expiry: "2026-12-31" });
    // part2 has no quote anywhere.

    const { order } = await asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-08-15",
      lines: [line(f.part.id), line(f.part2.id)],
    }));

    expect(order.lines[0]).toMatchObject({
      quoteLineId: latest.line.id, quoteId: latest.quote.id, quoteNumber: 1002,
    });
    expect(order.lines[1]).toMatchObject({ quoteLineId: null, quoteId: null, quoteNumber: null });

    // The read path agrees with the save response (the hub's own fetch).
    const fetched = await getOrder(order.id);
    expect(fetched.lines[0].quoteNumber).toBe(1002);
    expect(fetched.lines[1].quoteLineId).toBeNull();
  });

  it("an EXPLICIT id overrides the auto-winner after passing the same eligibility rule", async () => {
    const f = await orderFixture();
    const early = await makeQuote(f, { number: 1001, effective: "2026-07-01", expiry: "2026-12-31" });
    await makeQuote(f, { number: 1002, effective: "2026-08-01", expiry: "2026-12-31" });

    const { order } = await asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-08-15",
      lines: [line(f.part.id, { quoteLineId: early.line.id })],
    }));
    expect(order.lines[0]).toMatchObject({ quoteLineId: early.line.id, quoteNumber: 1001 });
  });

  it("an EXPLICIT null stores no link even while a quote is eligible", async () => {
    const f = await orderFixture();
    await makeQuote(f, { number: 1001, effective: "2026-08-01", expiry: "2026-12-31" });

    const { order } = await asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-08-15",
      lines: [line(f.part.id, { quoteLineId: null })],
    }));
    expect(order.lines[0].quoteLineId).toBeNull();
  });

  it("an explicit id failing eligibility 400s naming the LINE and the REASON, and nothing is saved", async () => {
    const f = await orderFixture();
    const closed = await makeQuote(f, {
      number: 1050, effective: "2026-08-01", expiry: "2026-12-31", status: "CLOSED",
    });
    await expect(asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-08-15",
      lines: [line(f.part.id, { quoteLineId: closed.line.id })],
    }))).rejects.toMatchObject({
      status: 400, message: "Line 1 (ACME · P-100): Quote #1050 is closed",
    });

    // A rider's failure names the rider's real position, not "Line 1".
    const otherPartQuote = await makeQuote(f, {
      number: 1051, effective: "2026-08-01", expiry: "2026-12-31", line: { partId: f.part.id },
    });
    await expect(asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-08-15",
      lines: [line(f.part.id), line(f.part2.id, { quoteLineId: otherPartQuote.line.id })],
    }))).rejects.toMatchObject({
      status: 400,
      message: "Line 2 (ACME · P-200): Quote #1051's line quotes a different part",
    });

    // Out-of-window: judged against the ORDER's received date, both ends inclusive.
    const window = await makeQuote(f, { number: 1052, effective: "2026-09-01", expiry: "2026-09-30" });
    await expect(asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-08-15",
      lines: [line(f.part.id, { quoteLineId: window.line.id })],
    }))).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Quote #1052 is not in effect on 2026-08-15"),
    });

    // Every refusal above rolled its whole save back — no order, no consumed number.
    expect(await prisma.order.count()).toBe(0);
  });

  it("the create audit entry's lines carry the link — quoteLineId AND the human-readable quote number", async () => {
    const f = await orderFixture();
    const q = await makeQuote(f, { number: 1060, effective: "2026-08-01", expiry: "2026-12-31" });
    const { order } = await asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-08-15", lines: [line(f.part.id)],
    }));

    const entry = (await prisma.auditLog.findMany({
      where: { entity: "order", entityId: order.id, action: "create" },
    }))[0];
    const after = entry.after as { lines: { quoteLineId: string | null; quoteNumber: number | null }[] };
    expect(after.lines[0]).toMatchObject({ quoteLineId: q.line.id, quoteNumber: 1060 });
  });
});

describe("addLine: the same three-way semantics, judged against the ORDER's received date", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    quoteSeq = 0;
  });

  it("auto-resolves against the stored receivedDate, not today — a backdated order links a quote whose window is long past", async () => {
    const f = await orderFixture();
    // Covers 2026-05-15 only — nowhere near today, so linking proves the judged date.
    const past = await makeQuote(f, {
      number: 1070, effective: "2026-05-01", expiry: "2026-05-31", line: { partId: f.part2.id },
    });
    const { order } = await asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-05-15", lines: [line(f.part.id)],
    }));

    const { order: after } = await asSystem(() => addLine(order.id, line(f.part2.id)));
    expect(after.lines[1]).toMatchObject({ quoteLineId: past.line.id, quoteNumber: 1070 });
  });

  it("explicit null stores no link; an ineligible explicit id names the rider's REAL position", async () => {
    const f = await orderFixture();
    const q = await makeQuote(f, {
      number: 1071, effective: "2026-08-01", expiry: "2026-12-31", line: { partId: f.part2.id },
    });
    const { order } = await asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-08-15", lines: [line(f.part.id)],
    }));

    const { order: nulled } = await asSystem(() =>
      addLine(order.id, line(f.part2.id, { quoteLineId: null })));
    expect(nulled.lines[1].quoteLineId).toBeNull();

    // Position 3 by now — the refusal must say "Line 3", not "Line 1".
    await expect(asSystem(() => addLine(order.id, line(f.part.id, { quoteLineId: q.line.id }))))
      .rejects.toMatchObject({
        status: 400,
        message: "Line 3 (ACME · P-100): Quote #1071's line quotes a different part",
      });
  });
});

describe("updateLine: explicit re-pick/unlink; an absent key NEVER re-judges (ruling 6)", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    quoteSeq = 0;
  });

  async function linkedOrder(f: OrderFixture) {
    const q = await makeQuote(f, { number: 1080, effective: "2026-08-10", expiry: "2026-08-20" });
    const { order } = await asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-08-15", lines: [line(f.part.id)],
    }));
    expect(order.lines[0].quoteLineId).toBe(q.line.id);
    return { q, order };
  }

  it("a qty-only edit keeps the stored link untouched — even after the quote has CLOSED", async () => {
    const f = await orderFixture();
    const { q, order } = await linkedOrder(f);
    await prisma.quote.update({ where: { id: q.quote.id }, data: { status: "CLOSED" } });

    const { order: after } = await asSystem(() =>
      updateLine(order.id, order.lines[0].id, { qty: 99 }));
    expect(after.lines[0]).toMatchObject({ qty: 99, quoteLineId: q.line.id, quoteNumber: 1080 });
  });

  it("an explicit null unlinks — the deliberate order-side edit ruling 6 names", async () => {
    const f = await orderFixture();
    const { order } = await linkedOrder(f);
    const { order: after } = await asSystem(() =>
      updateLine(order.id, order.lines[0].id, { quoteLineId: null }));
    expect(after.lines[0].quoteLineId).toBeNull();
  });

  it("an explicit re-pick is judged against the CURRENT received date — a pick outside it 400s with the line named", async () => {
    const f = await orderFixture();
    const { order } = await linkedOrder(f);
    const other = await makeQuote(f, { number: 1081, effective: "2026-08-01", expiry: "2026-12-31" });

    // Eligible re-pick lands.
    const { order: repicked } = await asSystem(() =>
      updateLine(order.id, order.lines[0].id, { quoteLineId: other.line.id }));
    expect(repicked.lines[0]).toMatchObject({ quoteLineId: other.line.id, quoteNumber: 1081 });

    // An out-of-window pick is refused against the order's CURRENT received date.
    const stale = await makeQuote(f, { number: 1082, effective: "2026-01-01", expiry: "2026-01-31" });
    await expect(asSystem(() =>
      updateLine(order.id, order.lines[0].id, { quoteLineId: stale.line.id })))
      .rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("Line 1 (ACME · P-100): Quote #1082 is not in effect"),
      });
  });

  it("a link change reads as a QUOTE NUMBER in order history, not a bare cuid (SNAPSHOT_INCLUDE.order)", async () => {
    const f = await orderFixture();
    const { order } = await linkedOrder(f);
    const other = await makeQuote(f, { number: 1085, effective: "2026-08-01", expiry: "2026-12-31" });

    await asSystem(() => updateLine(order.id, order.lines[0].id, { quoteLineId: other.line.id }));

    const entry = (await prisma.auditLog.findMany({
      where: { entity: "order", entityId: order.id, action: "update" },
      orderBy: [{ at: "desc" }, { id: "desc" }], take: 1,
    }))[0];
    type Snap = { lines: { quoteLine: { quote: { quoteNumber: number } } | null }[] };
    expect((entry.before as Snap).lines[0].quoteLine?.quote.quoteNumber).toBe(1080);
    expect((entry.after as Snap).lines[0].quoteLine?.quote.quoteNumber).toBe(1085);
  });
});

describe("ruling 6: a received-date edit never re-judges stored links", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    quoteSeq = 0;
  });

  it("moving receivedDate outside the quote's window leaves the link standing", async () => {
    const f = await orderFixture();
    const q = await makeQuote(f, { number: 1090, effective: "2026-08-10", expiry: "2026-08-20" });
    const { order } = await asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-08-15", lines: [line(f.part.id)],
    }));
    expect(order.lines[0].quoteLineId).toBe(q.line.id);

    await asSystem(() => updateOrder(order.id, { receivedDate: "2026-11-01" }));

    const after = await getOrder(order.id);
    expect(after.receivedDate).toBe("2026-11-01");
    expect(after.lines[0]).toMatchObject({ quoteLineId: q.line.id, quoteNumber: 1090 });
  });
});

describe("the idempotent replay returns the SAME links (the clientRequestId path)", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    quoteSeq = 0;
  });

  it("a replay echoes the stored link — no re-judgement, even after the quote closed", async () => {
    const f = await orderFixture();
    const q = await makeQuote(f, { number: 1095, effective: "2026-08-01", expiry: "2026-12-31" });
    const clientRequestId = crypto.randomUUID();
    const input = {
      customerId: f.customer.id, receivedDate: "2026-08-15", clientRequestId,
      lines: [line(f.part.id)],
    };

    const first = await asSystem(() => createOrder(input));
    expect(first.order.lines[0].quoteLineId).toBe(q.line.id);
    expect(first.deduped).toBeUndefined();

    // The quote closes between the save and the retry — a re-judgement would now refuse or
    // unlink; the replay must instead return the order the request already created, link intact.
    await prisma.quote.update({ where: { id: q.quote.id }, data: { status: "CLOSED" } });

    const replay = await asSystem(() => createOrder(input));
    expect(replay.deduped).toBe(true);
    expect(replay.order.id).toBe(first.order.id);
    expect(replay.order.lines[0]).toMatchObject({ quoteLineId: q.line.id, quoteNumber: 1095 });
    expect(await prisma.order.count()).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------
// STANDING INVARIANT (the §5.14 SSI pairing — Task 4's review, Important #1): the order save's
// Serializable isolation plus its IN-TRANSACTION eligibility read of the quote line it links
// (resolveQuoteLinks → quote-links.ts, on the save's own tx client) are BOTH load-bearing.
// quotes.ts's updateQuote/deleteQuote guard "no order line references this quote line" with a
// Serializable predicate read over OrderLine rows; the racing pair only forms an SSI cycle —
// link-save reads the quote line (rw → the drop's write) AND the drop reads the OrderLine
// predicate (rw → the link's insert) — when the link writer holds up its half. Downgrade the
// order save to Read Committed, or move the eligibility read onto the bare prisma client, and
// both sides commit: the link lands pointing at a soft-DELETED quote line, the exact
// silent-re-price §7.5 exists to prevent.
//
// The DANGEROUS direction, RED-verified by pinning saveNewOrder's transaction to ReadCommitted
// (the one-line isolationLevel swap): the gated save's eligibility read saw the line live from
// its pre-drop snapshot, updateQuote committed the drop mid-save, nothing aborted, and the
// committed order's line held `quoteLineId` = the dead line's id beside `deletedAt` set on that
// same QuoteLine row. Restored to Serializable, the save aborts 40001 → the retryable 409 and
// no order row survives.
//
// Determinism (the close-periods GATE technique): a Read Committed gate holds the
// `order_number_next` Setting row FOR UPDATE, so the real createOrder fixes its snapshot, runs
// its eligibility read (sees the line live), then BLOCKS at allocateNumber's SELECT … FOR
// UPDATE — paused AFTER its SSI read and BEFORE its writes. The real updateQuote (Serializable —
// its payload drops a line, so `assignsFk` holds) then commits the drop, the gate releases, and
// the save proceeds on its stale snapshot into the abort. The gate is Read Committed on purpose:
// it must hold the row without forming any SSI edge of its own.
// -------------------------------------------------------------------------------------------
describe("the §5.14 SSI pairing — dangerous direction (STANDING INVARIANT)", () => {
  beforeEach(async () => {
    await truncateAll();
    await seedOrderGatePrereqs();
    quoteSeq = 0;
  });

  it("a link save whose snapshot predates a committed line-drop ABORTS (409) — the link never lands on a dead line", async () => {
    const f = await orderFixture();
    // Two lines so updateQuote can DROP the part line while keeping one (lines min 1): the
    // free-text keeper is never eligible, so the save's auto-resolution targets the dropped one.
    const quote = await prisma.quote.create({
      data: {
        quoteNumber: 1100, customerId: f.customer.id, quotedById: f.user.id,
        quoteDate: d("2026-08-01"), effectiveDate: d("2026-08-01"), expiryDate: d("2026-12-31"),
        lines: {
          create: [
            { position: 1, partId: f.part.id },
            { position: 2, partNumberText: "KEEP" },
          ],
        },
      },
      include: { lines: { orderBy: { position: "asc" } } },
    });
    const [target, keeper] = quote.lines;

    // The counter row must EXIST for the gate to grip it — after truncateAll, `allocateNumber`
    // would otherwise find no row to FOR-UPDATE, never block, and the save would commit before
    // the drop even starts (measured: updateQuote then refuses §5.14-style, a different test).
    await prisma.setting.create({ data: { key: "order_number_next", value: 1000 } });

    let gateHeld!: () => void;
    const held = new Promise<void>((r) => { gateHeld = r; });
    let releaseGate!: () => void;
    const gateRelease = new Promise<void>((r) => { releaseGate = r; });

    // The GATE: Read Committed, holds the order-number counter row, forms no SSI edge.
    const gate = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "key" FROM "Setting" WHERE "key" = 'order_number_next' FOR UPDATE`;
      gateHeld();
      await gateRelease;
    }, { timeout: 20000 });
    await held;

    // The REAL link save: snapshot fixes at its first read; the eligibility read sees `target`
    // live; then it blocks at allocateNumber on the gated counter row.
    const save = asSystem(() => createOrder({
      customerId: f.customer.id, receivedDate: "2026-08-15", lines: [line(f.part.id)],
    })).then(() => "resolved" as const, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200)); // let it read + block

    // The REAL updateQuote drops the linked-to-be line and COMMITS while the save is paused.
    await runWithContext({ actor: { id: f.user.id, name: "QL User" }, user: null }, () =>
      updateQuote(quote.id, { lines: [{ id: keeper.id, partNumberText: "KEEP" }] }));
    const dropped = await prisma.quoteLine.findFirst({ where: { id: target.id } });
    expect(dropped?.deletedAt).not.toBeNull();

    releaseGate();
    await gate;

    // SSI aborts the save (40001 → the retryable 409). Nothing survives: no order row, so no
    // link can point at the dead line — the retry re-resolves against the post-drop truth.
    const outcome = await save;
    expect(outcome).not.toBe("resolved");
    expect(outcome).toMatchObject({ status: 409 });
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.orderLine.count({ where: { quoteLineId: target.id } })).toBe(0);
  });
});
