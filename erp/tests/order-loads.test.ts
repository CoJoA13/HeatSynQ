import { describe, it, expect, beforeEach } from "vitest";
import { ZodError } from "zod";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, updateLine, voidOrder } from "@/server/orders";
import { replaceLoads, resplitLoads } from "@/server/order-loads";
import { readAudit } from "@/server/audit";
import { readableMessage } from "@/server/error-message";
import { MAX_LOADS } from "@/lib/load-split";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** ACME with a lead part carrying a 40/load cap and a process-steps revision — the orderability
 *  precondition (spec §5.3), the `orders.test.ts` fixture() precedent, trimmed to what this file
 *  needs (no rider — loads tests operate on the order's TOTALS, and a single line keeps every
 *  fixture's numbers easy to check by hand). */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  const lead = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "P-100", name: "Ring gear", eachWeight: "10.0000", loadQty: 40 },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: lead.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
  return { customer, lead };
}

/** One line at `qty`/`weight` (defaults: 100 pcs / 1,000 lb — under the fixture lead's 40/load
 *  cap, so createOrder auto-splits it into 3 loads: 40/40/20). */
async function baseOrder(leadId: string, customerId: string, qty = 100, weight = "1000.00") {
  const { order } = await asSystem(() => createOrder({
    customerId, lines: [{ partId: leadId, qty, weight }],
  }));
  return order;
}

describe("replaceLoads", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("rejects a gap in the load-number set", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    await expect(asSystem(() => replaceLoads(order.id, [
      { loadNumber: 1, qty: 50, weight: "500.00" },
      { loadNumber: 3, qty: 50, weight: "500.00" },
    ]))).rejects.toMatchObject({ status: 400, message: "Load numbers must be 1..N with no gaps or repeats" });
  });

  it("rejects a repeated load number", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    await expect(asSystem(() => replaceLoads(order.id, [
      { loadNumber: 1, qty: 50, weight: "500.00" },
      { loadNumber: 1, qty: 50, weight: "500.00" },
    ]))).rejects.toMatchObject({ status: 400, message: "Load numbers must be 1..N with no gaps or repeats" });
  });

  it("rejects an empty load list", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);
    await expect(asSystem(() => replaceLoads(order.id, []))).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects a load row with neither qty nor weight", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    await expect(asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: null, weight: null }])))
      .rejects.toBeInstanceOf(ZodError);
  });

  it("accepts a row carrying only qty, and one carrying only weight", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    const { order: after } = await asSystem(() => replaceLoads(order.id, [
      { loadNumber: 1, qty: 60, weight: null },
      { loadNumber: 2, qty: null, weight: "400.00" },
    ]));
    expect(after.loads).toEqual([
      { id: expect.any(String), loadNumber: 1, qty: 60, weight: null },
      { id: expect.any(String), loadNumber: 2, qty: null, weight: 400 },
    ]);
  });

  // Fix-wave R3 finding 3: cumulative-rounding auto-splits legitimately produce 0-weight loads
  // (load-split.test.ts's own counter-example, restated here) whenever a load carries qty ≥ 1 —
  // but this validator rejected weight === 0 unconditionally, so a legal auto-split could never be
  // re-saved once loaded back into the editor. A weight-ONLY row (qty null) still needs weight > 0
  // — there is nothing else on that row for a positive weight to describe.
  it("round-trips the load-split counter-example's zero-weight rows (qty ≥ 1 on every row)", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    const { order: after } = await asSystem(() => replaceLoads(order.id, [
      { loadNumber: 1, qty: 1, weight: "0.01" },
      { loadNumber: 2, qty: 1, weight: "0" },
      { loadNumber: 3, qty: 1, weight: "0.01" },
      { loadNumber: 4, qty: 1, weight: "0" },
      { loadNumber: 5, qty: 1, weight: "0.01" },
    ]));
    expect(after.loads.map((l) => ({ qty: l.qty, weight: l.weight }))).toEqual([
      { qty: 1, weight: 0.01 }, { qty: 1, weight: 0 }, { qty: 1, weight: 0.01 },
      { qty: 1, weight: 0 }, { qty: 1, weight: 0.01 },
    ]);
  });

  it("still rejects a weight-only row (qty null) whose weight is zero", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    await expect(asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: null, weight: "0" }])))
      .rejects.toBeInstanceOf(ZodError);
  });

  it("still rejects a negative weight even when the row carries a qty", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    await expect(asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: 1, weight: "-1.00" }])))
      .rejects.toBeInstanceOf(ZodError);
  });

  // Fix-wave R4 finding 3: the auto-split path's qty already carried the Int4 bound (orders.ts's
  // CONTAINER_ITEM, R2 finding 3's own fix), but the MANUAL load editor's qty was bounded only
  // below (`min(1)`). `Load.qty` is a Postgres `Int` — anything past 2,147,483,647 is not a
  // business refusal at all, it is an unmapped 22003 numeric-overflow escaping the transaction
  // as a 500. A fat-fingered paste is a validation error, not a server error.
  it("rejects a manual load qty past the Int4 ceiling", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    await expect(asSystem(() => replaceLoads(order.id,
      [{ loadNumber: 1, qty: 2_147_483_648, weight: "1000.00" }])))
      .rejects.toBeInstanceOf(ZodError);
    // The ceiling itself is still accepted — the bound is the column's, not an arbitrary one.
    const { order: saved } = await asSystem(() => replaceLoads(order.id,
      [{ loadNumber: 1, qty: 2_147_483_647, weight: "1000.00" }]));
    expect(saved.loads[0].qty).toBe(2_147_483_647);
  });

  // #42's manual-path half: `Load.weight` is a DECIMAL(12,2) — `decimalField(12, 2)` already
  // bounds the manual editor to ten integer digits, so the overflow is refused at zod exactly
  // like the Int4 qty above. Pinned here so the generated-path guard (splitLoads) and this one
  // can never drift apart silently.
  it("rejects a manual load weight past the Decimal(12,2) ceiling", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    await expect(asSystem(() => replaceLoads(order.id,
      [{ loadNumber: 1, qty: 1, weight: "10000000000.00" }])))
      .rejects.toBeInstanceOf(ZodError);
    // The ceiling itself is still accepted.
    const { order: saved } = await asSystem(() => replaceLoads(order.id,
      [{ loadNumber: 1, qty: 1, weight: "9999999999.99" }]));
    expect(saved.loads[0].weight).toBe(9_999_999_999.99);
  });

  // Fix-wave R4 finding 4: `MAX_LOADS` was enforced only on the AUTO-SPLIT path (runSplitLoads,
  // orders.ts) — the manual bulk replace could set a load count no split would ever produce, one
  // INSERT per row inside a single Serializable transaction. Same cap, now on both doors.
  it("rejects a manual replacement past the MAX_LOADS cap, naming the limit", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    const tooMany = Array.from({ length: MAX_LOADS + 1 }, (_, i) => ({ loadNumber: i + 1, qty: 1, weight: null }));
    const err = await asSystem(() => replaceLoads(order.id, tooMany)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZodError);
    // Discoverable: the refusal says what the ceiling is, not just that one was hit.
    expect(readableMessage(err as ZodError)).toContain("10,000");

    // Nothing was written — the cap is reached before the transaction opens.
    expect(await prisma.load.count({ where: { orderId: order.id } })).toBe(3);
  });

  it("rejects an unrecognized key on a load row (.strict())", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    await expect(asSystem(() => replaceLoads(order.id,
      [{ loadNumber: 1, qty: 100, weight: "1000.00", id: "not-a-real-field" }])))
      .rejects.toBeInstanceOf(ZodError);
  });

  it("swaps a renumber atomically across three loads (two-phase negative-park rewrite)", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);

    const first = await asSystem(() => replaceLoads(order.id, [
      { loadNumber: 1, qty: 10, weight: "100.00" },
      { loadNumber: 2, qty: 20, weight: "200.00" },
      { loadNumber: 3, qty: 30, weight: "300.00" },
    ]));
    const idOf = (loads: typeof first.order.loads, n: number) => loads.find((l) => l.loadNumber === n)!.id;
    const [id1, id2, id3] = [1, 2, 3].map((n) => idOf(first.order.loads, n));

    // Reverse 1 <-> 3, leave 2 in place — a direct (non-parked) rewrite would violate
    // @@unique([orderId, loadNumber]) on the very first UPDATE statement.
    const swapped = await asSystem(() => replaceLoads(order.id, [
      { loadNumber: 3, qty: 10, weight: "100.00" },
      { loadNumber: 2, qty: 20, weight: "200.00" },
      { loadNumber: 1, qty: 30, weight: "300.00" },
    ]));

    expect(swapped.order.loads).toHaveLength(3);
    const byNumber = (n: number) => swapped.order.loads.find((l) => l.loadNumber === n)!;
    // Content moved to its new number...
    expect(byNumber(1)).toMatchObject({ qty: 30, weight: 300 });
    expect(byNumber(2)).toMatchObject({ qty: 20, weight: 200 });
    expect(byNumber(3)).toMatchObject({ qty: 10, weight: 100 });
    // ...and it is the SAME underlying row that moved (in-place rewrite, not delete+recreate) —
    // the swap's whole point is that no @@unique collision happened along the way.
    expect(byNumber(1).id).toBe(id3);
    expect(byNumber(2).id).toBe(id2);
    expect(byNumber(3).id).toBe(id1);
  });

  it("creates extra loads when the new set is longer than the old one", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id); // starts with 3 loads (40/40/20)

    const { order: after } = await asSystem(() => replaceLoads(order.id, [
      { loadNumber: 1, qty: 25, weight: "250.00" },
      { loadNumber: 2, qty: 25, weight: "250.00" },
      { loadNumber: 3, qty: 25, weight: "250.00" },
      { loadNumber: 4, qty: 25, weight: "250.00" },
    ]));
    expect(after.loads).toHaveLength(4);
    expect(await prisma.load.count({ where: { orderId: order.id } })).toBe(4);
  });

  it("deletes surplus loads when the new set is shorter than the old one", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id); // starts with 3 loads (40/40/20)

    const { order: after } = await asSystem(() => replaceLoads(order.id, [
      { loadNumber: 1, qty: 100, weight: "1000.00" },
    ]));
    expect(after.loads).toHaveLength(1);
    expect(await prisma.load.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("warns when the replaced loads no longer sum to the order", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id, 40, "400.00");

    const { warnings } = await asSystem(() => replaceLoads(order.id, [
      { loadNumber: 1, qty: 10, weight: "100.00" },
    ]));
    expect(warnings).toContain("Loads no longer sum to the order — re-split or edit loads");
  });

  it("has no sum-mismatch warning when the replaced loads still sum to the order", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id, 40, "400.00");

    const { warnings } = await asSystem(() => replaceLoads(order.id, [
      { loadNumber: 1, qty: 25, weight: "250.00" },
      { loadNumber: 2, qty: 15, weight: "150.00" },
    ]));
    expect(warnings).not.toContain("Loads no longer sum to the order — re-split or edit loads");
  });

  it("returns the traveler-reprint warning only once a StoredDocument exists for the order", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id, 40, "400.00");

    const before = await asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: 40, weight: "400.00" }]));
    expect(before.warnings).not.toContain("A traveler has already printed — print a fresh one");

    await prisma.storedDocument.create({
      data: { orderId: order.id, kind: "TRAVELER", fileData: Buffer.from("pdf-bytes") },
    });

    const after = await asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: 40, weight: "400.00" }]));
    expect(after.warnings).toContain("A traveler has already printed — print a fresh one");
  });

  it("404s a voided order", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);
    await asSystem(() => voidOrder(order.id, "wrong customer"));

    await expect(asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: 100, weight: "1000.00" }])))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
  });

  it("404s an unknown order id", async () => {
    await expect(asSystem(() => replaceLoads("nope", [{ loadNumber: 1, qty: 1, weight: "1.00" }])))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
  });

  // Fix-wave R3 finding 1: replaceLoads used to resolve the order with a plain, UNLOCKED
  // findFirst, so it never serialized against anything else holding a claim on the same row —
  // in particular, printTraveler's own `SELECT … FOR UPDATE` (traveler.ts). The discriminating
  // shape is the same holder pattern round 2's print-vs-void race test uses (traveler.test.ts):
  // a holder takes the EXACT row lock `claimOrder` (order-locks.ts) now gives every order-family
  // mutator and just sits on it. A genuine claim inside replaceLoads cannot proceed past the
  // holder until it releases; a plain (unlocked) resolve — the regression — would sail straight
  // through and never even notice the holder is there.
  it("blocks on a concurrent claim of the order row until it releases (row-lock discipline)", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id); // 3 loads: 40/40/20

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      hasClaimed();
      await release;
    }, { timeout: 20000 });

    await claimed;
    const replaceCall = asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: 100, weight: "1000.00" }]));

    // Not itself the discriminator (see above) — its job is to guarantee replaceLoads' own claim
    // attempt has actually been dispatched, and in the correct implementation is genuinely
    // blocked on the holder, before the holder is released.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      replaceCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    // The discriminator: replaceLoads could not decide anything about this order until AFTER the
    // holder released, and then proceeded and landed normally.
    const { order: after } = await replaceCall;
    expect(after.loads).toHaveLength(1);
    expect(after.loads[0]).toMatchObject({ qty: 100, weight: 1000 });
  });

  it("audits a real before/after diff of the loads collection", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id, 40, "400.00"); // single load: 40/400

    await asSystem(() => replaceLoads(order.id, [
      { loadNumber: 1, qty: 25, weight: "250.00" },
      { loadNumber: 2, qty: 15, weight: "150.00" },
    ]));

    const [entry] = await readAudit("order", order.id); // most recent first
    expect(entry.action).toBe("update");
    const before = entry.before as { loads: { loadNumber: number; qty: number | null }[] };
    const after = entry.after as { loads: { loadNumber: number; qty: number | null }[] };
    expect(before.loads).toHaveLength(1);
    expect(before.loads[0]).toMatchObject({ loadNumber: 1, qty: 40 });
    expect(after.loads).toHaveLength(2);
    expect(after.loads[0]).toMatchObject({ loadNumber: 1, qty: 25 });
    expect(after.loads[1]).toMatchObject({ loadNumber: 2, qty: 15 });
  });
});

describe("resplitLoads", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("rebuilds loads from the order's current totals after a qty edit, under the lead's cap", async () => {
    const { customer, lead } = await fixture(); // loadQty cap: 40
    const order = await baseOrder(lead.id, customer.id, 100, "1000.00"); // -> 40/40/20 at creation

    await asSystem(() => updateLine(order.id, order.lines[0].id, { qty: 250, weight: "2500.00" }));

    const { order: after, warnings } = await asSystem(() => resplitLoads(order.id));

    // 250 pcs @ 40/load -> six full loads + a 10-piece remainder.
    expect(after.loads).toHaveLength(7);
    expect(after.loads.slice(0, 6).every((l) => l.qty === 40)).toBe(true);
    expect(after.loads[6].qty).toBe(10);
    expect(after.loads.reduce((s, l) => s + (l.qty ?? 0), 0)).toBe(250);
    expect(after.loads.reduce((s, l) => s + Math.round((l.weight ?? 0) * 100), 0)).toBe(250_000);
    expect(warnings).not.toContain("Loads no longer sum to the order — re-split or edit loads");
  });

  // Fix-wave R2 finding 3: resplitLoads reads the part's LIVE cap (the very next test's point),
  // which means a cap edited down to something tiny against a large order is exactly the shape
  // that used to allocate an unbounded number of Load objects. Same clean-400 contract as
  // createOrder's own mapping, not a hang or a 500.
  it("maps a re-split that would exceed 10,000 loads to a clean 400, naming the count", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id, 100, "1000.00");

    await prisma.part.update({ where: { id: lead.id }, data: { loadQty: 1 } });
    await asSystem(() => updateLine(order.id, order.lines[0].id, { qty: 10_001, weight: "10001.00" }));

    await expect(asSystem(() => resplitLoads(order.id))).rejects.toMatchObject({
      status: 400,
      message: "This split would produce 10001 loads (max 10,000) — check the part's load quantity",
    });
  });

  // #42: resplitLoads generates its loads through the same splitLoads guard createOrder uses, so
  // an order whose line totals have grown past a destination-column ceiling (each line's own
  // INTEGER column still fits — only the SUM does not) refuses with the field-anchored 400
  // instead of an unmapped Postgres overflow 500, and leaves the existing loads untouched.
  it("maps a re-split past the Int4 qty ceiling to the field-anchored 400 and leaves loads untouched", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id); // 100 pcs → 40/40/20 under the 40 cap

    // Raw prisma on purpose: three lines of 1,000,000,000 each are individually storable, and the
    // per-line zod cap (LINE_QTY, 10,000,000) makes this state unreachable through one save — but
    // an order grows line by line. The cap is removed so the re-split makes ONE load of the total.
    await prisma.part.update({ where: { id: lead.id }, data: { loadQty: null } });
    await prisma.orderLine.update({ where: { id: order.lines[0].id }, data: { qty: 1_000_000_000 } });
    await prisma.orderLine.create({
      data: { orderId: order.id, position: 2, partId: lead.id, qty: 1_000_000_000, weight: "1.00" },
    });
    await prisma.orderLine.create({
      data: { orderId: order.id, position: 3, partId: lead.id, qty: 1_000_000_000, weight: "1.00" },
    });

    await expect(asSystem(() => resplitLoads(order.id))).rejects.toMatchObject({
      status: 400,
      message: "Load 1's quantity 3,000,000,000 exceeds the database maximum 2,147,483,647 — check the line quantities",
    });
    const loads = await prisma.load.findMany({ where: { orderId: order.id }, orderBy: { loadNumber: "asc" } });
    expect(loads.map((l) => l.qty)).toEqual([40, 40, 20]);
  });

  it("uses the part's LIVE loadQty cap, not whatever it was at order-creation time", async () => {
    const { customer, lead } = await fixture(); // loadQty cap: 40 at creation
    const order = await baseOrder(lead.id, customer.id, 250, "2500.00"); // -> six loads at creation

    await prisma.part.update({ where: { id: lead.id }, data: { loadQty: 25 } }); // cap edited since

    const { order: after } = await asSystem(() => resplitLoads(order.id));
    expect(after.loads).toHaveLength(10); // 250 / 25 exactly
    expect(after.loads.every((l) => l.qty === 25)).toBe(true);
  });

  it("puts the totals in a single load when the lead part carries no caps", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC2", name: "Acme Two" } });
    const code = await prisma.processStepCode.create({ data: { code: "HT-02", name: "Temper" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-200", eachWeight: "5.0000" }, // no loadQty/loadWeight
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id } });
    const order = await baseOrder(part.id, customer.id, 60, "300.00");

    const { order: after } = await asSystem(() => resplitLoads(order.id));
    expect(after.loads).toHaveLength(1);
    expect(after.loads[0]).toMatchObject({ loadNumber: 1, qty: 60, weight: 300 });
  });

  it("returns the traveler-reprint warning only once a StoredDocument exists for the order", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id, 40, "400.00");

    const before = await asSystem(() => resplitLoads(order.id));
    expect(before.warnings).not.toContain("A traveler has already printed — print a fresh one");

    await prisma.storedDocument.create({
      data: { orderId: order.id, kind: "TRAVELER", fileData: Buffer.from("pdf-bytes") },
    });

    const after = await asSystem(() => resplitLoads(order.id));
    expect(after.warnings).toContain("A traveler has already printed — print a fresh one");
  });

  it("404s a voided order", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id);
    await asSystem(() => voidOrder(order.id, "wrong customer"));

    await expect(asSystem(() => resplitLoads(order.id)))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
  });

  it("404s an unknown order id", async () => {
    await expect(asSystem(() => resplitLoads("nope")))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
  });

  it("audits a real before/after diff of the loads collection", async () => {
    const { customer, lead } = await fixture();
    const order = await baseOrder(lead.id, customer.id, 100, "1000.00"); // 40/40/20 at creation

    await asSystem(() => updateLine(order.id, order.lines[0].id, { qty: 80, weight: "800.00" }));
    await asSystem(() => resplitLoads(order.id));

    const [entry] = await readAudit("order", order.id); // most recent first
    expect(entry.action).toBe("update");
    const before = entry.before as { loads: { loadNumber: number; qty: number | null }[] };
    const after = entry.after as { loads: { loadNumber: number; qty: number | null }[] };
    expect(before.loads.map((l) => l.qty)).toEqual([40, 40, 20]);
    expect(after.loads.map((l) => l.qty)).toEqual([40, 40]);
  });
});
