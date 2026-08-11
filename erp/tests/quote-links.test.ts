import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { eligibleQuoteLines, resolveAutoLink, judgeQuoteLine } from "@/server/quote-links";
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
