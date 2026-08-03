import { describe, it, expect, beforeEach } from "vitest";
import { ZodError } from "zod";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, updateLine, voidOrder } from "@/server/orders";
import { replaceLoads, resplitLoads } from "@/server/order-loads";
import { readAudit } from "@/server/audit";

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
  beforeEach(truncateAll);

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
  beforeEach(truncateAll);

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
