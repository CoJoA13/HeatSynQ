import { describe, it, expect, beforeEach } from "vitest";
import { ZodError } from "zod";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import {
  createPart, updatePart, deletePart, getPart, listParts, partOrderBlockers,
} from "@/server/parts";
import { createOrder, voidOrder } from "@/server/orders";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function twoCustomers() {
  const acme = await prisma.customer.create({ data: { code: "ACME", name: "Acme Foundry" } });
  const beta = await prisma.customer.create({ data: { code: "BETA", name: "Beta Co" } });
  return { acme, beta };
}

/** Gives a part revision 1 with one step — createOrder's orderability precondition for whichever
 *  part is the LEAD of an order (spec §5.3), same fixture shape as orders.test.ts's own
 *  `giveSteps`, built with raw prisma so this file's fixtures don't depend on the process-steps
 *  service. */
async function giveSteps(partId: string) {
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

describe("parts core", () => {
  beforeEach(truncateAll);

  it("creates with required fields and lists with customer + material names resolved", async () => {
    const { acme } = await twoCustomers();
    const mat = await prisma.material.create({ data: { name: "Ductile iron" } });
    await asSystem(() => createPart({
      customerId: acme.id, partNumber: "12345", eachWeight: "2.5000", materialId: mat.id,
    }));
    const rows = await listParts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partNumber: "12345", customerCode: "ACME", customerName: "Acme Foundry",
      materialName: "Ductile iron", eachWeight: 2.5, pricePer: "EACH", active: true,
    });
  });

  it("same part number coexists under two customers; duplicate under one 400s", async () => {
    const { acme, beta } = await twoCustomers();
    await asSystem(() => createPart({ customerId: acme.id, partNumber: "12345", eachWeight: 1 }));
    await asSystem(() => createPart({ customerId: beta.id, partNumber: "12345", eachWeight: 1 }));
    expect(await prisma.part.count()).toBe(2);
    await expect(asSystem(() => createPart({ customerId: acme.id, partNumber: "12345", eachWeight: 1 })))
      .rejects.toThrow("A part with that part number already exists for that customer");
  });

  it("delete-then-rekey creates a genuinely new row with fresh history (no revival)", async () => {
    const { acme } = await twoCustomers();
    const { id: first } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "77", eachWeight: 1 }));
    await asSystem(() => deletePart(first, "typo"));
    const { id: second } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "77", eachWeight: 2 }));
    expect(second).not.toBe(first);
    const history = await prisma.auditLog.findMany({ where: { entity: "part", entityId: second } });
    expect(history.map((h) => h.action)).toEqual(["create"]);
  });

  it("eachWeight must be > 0 and fit Decimal(10,4); prices carry 4 decimals", async () => {
    const { acme } = await twoCustomers();
    await expect(asSystem(() => createPart({ customerId: acme.id, partNumber: "A", eachWeight: 0 })))
      .rejects.toThrow("Must be greater than zero");
    await expect(asSystem(() => createPart({ customerId: acme.id, partNumber: "A", eachWeight: "1.00001" })))
      .rejects.toThrow("4 digits after the decimal point");
    const { id } = await asSystem(() => createPart({
      customerId: acme.id, partNumber: "A", eachWeight: "0.0500", unitPrice: "0.0575", pricePer: "LB",
    }));
    expect((await getPart(id)).unitPrice).toBe(0.0575);
  });

  it("customerId is immutable after create", async () => {
    const { acme, beta } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "M1", eachWeight: 1 }));
    await expect(asSystem(() => updatePart(id, { customerId: beta.id })))
      .rejects.toThrow("A part cannot move to another customer");
  });

  it("materialId must reference a live material, on create and update", async () => {
    const { acme } = await twoCustomers();
    const dead = await prisma.material.create({ data: { name: "Gone", deletedAt: new Date() } });
    await expect(asSystem(() => createPart({
      customerId: acme.id, partNumber: "X", eachWeight: 1, materialId: dead.id,
    }))).rejects.toThrow("That material does not exist");

    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "X2", eachWeight: 1 }));
    await expect(asSystem(() => updatePart(id, { materialId: dead.id })))
      .rejects.toThrow("That material does not exist");
  });

  it("switching pricePer to LOT with live breaks is refused", async () => {
    const { acme } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "L", eachWeight: 1 }));
    await prisma.partPriceBreak.create({ data: { partId: id, threshold: "500", price: "0.95" } });
    await expect(asSystem(() => updatePart(id, { pricePer: "LOT" })))
      .rejects.toThrow("delete the price breaks first");
  });

  it("delete requires a reason and cascades children in one transaction", async () => {
    const { acme } = await twoCustomers();
    const spec = await prisma.specification.create({ data: { name: "ASTM A536" } });
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "D", eachWeight: 1 }));
    await prisma.partSpecification.create({ data: { partId: id, specificationId: spec.id } });
    await expect(asSystem(() => deletePart(id, "  "))).rejects.toThrow("A reason is required");
    await asSystem(() => deletePart(id, "keyed wrong"));
    expect((await prisma.part.findFirst({ where: { id } }))!.deletedAt).not.toBeNull();
    expect((await prisma.partSpecification.findFirst({ where: { partId: id } }))!.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({ where: { entity: "part", entityId: id, action: "delete" } });
    expect(entry!.reason).toBe("keyed wrong");
  });

  it("search matches part number, customer code, and customer name", async () => {
    const { acme, beta } = await twoCustomers();
    await asSystem(() => createPart({ customerId: acme.id, partNumber: "GEAR-9", eachWeight: 1 }));
    await asSystem(() => createPart({ customerId: beta.id, partNumber: "PIN-1", eachWeight: 1 }));
    expect((await listParts({ search: "gear" })).map((p) => p.partNumber)).toEqual(["GEAR-9"]);
    expect((await listParts({ search: "beta" })).map((p) => p.partNumber)).toEqual(["PIN-1"]);
    expect((await listParts({ search: "ACME" })).map((p) => p.partNumber)).toEqual(["GEAR-9"]);
  });

  it("update audit entries carry a real diff", async () => {
    const { acme } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "AU", eachWeight: 1 }));
    await asSystem(() => updatePart(id, { name: "Ring gear" }));
    const entry = await prisma.auditLog.findFirst({ where: { entity: "part", entityId: id, action: "update" } });
    const before = entry!.before as { name: string }; const after = entry!.after as { name: string };
    expect(before.name).toBe(""); expect(after.name).toBe("Ring gear");
  });

  it("inactive parts hide by default and appear with includeInactive", async () => {
    const { acme } = await twoCustomers();
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "IN", eachWeight: 1 }));
    await asSystem(() => updatePart(id, { active: false }));
    expect(await listParts()).toHaveLength(0);
    expect(await listParts({ includeInactive: true })).toHaveLength(1);
  });

  it("hasProcessSteps reflects the CURRENT revision only, batched (not N+1) across the list", async () => {
    const { acme } = await twoCustomers();
    const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austemper" } });
    const { id: none } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "NONE", eachWeight: 1 }));
    const { id: emptyRev } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "EMPTY", eachWeight: 1 }));
    const { id: withSteps } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "STEPPED", eachWeight: 1 }));

    // emptyRev: a revision exists but carries zero steps — still false, same as no revision at all.
    await prisma.partProcessRevision.create({ data: { partId: emptyRev, revisionNumber: 1 } });

    // withSteps: revision 1 had a step, but the CURRENT revision is 2 with none — must read false,
    // the same "superseded revision's steps don't count" rule lockCurrentRevision enforces.
    const rev1 = await prisma.partProcessRevision.create({ data: { partId: withSteps, revisionNumber: 1 } });
    await prisma.partProcessStep.create({ data: { revisionId: rev1.id, position: 1, codeId: code.id, instruction: "old" } });
    const rev2 = await prisma.partProcessRevision.create({ data: { partId: withSteps, revisionNumber: 2 } });

    let rows = await listParts();
    const byNumber = (n: string) => rows.find((r) => r.partNumber === n)!;
    expect(byNumber("NONE").hasProcessSteps).toBe(false);
    expect(byNumber("EMPTY").hasProcessSteps).toBe(false);
    expect(byNumber("STEPPED").hasProcessSteps).toBe(false); // current rev (2) has no steps yet

    await prisma.partProcessStep.create({ data: { revisionId: rev2.id, position: 1, codeId: code.id, instruction: "new" } });
    rows = await listParts();
    expect(byNumber("STEPPED").hasProcessSteps).toBe(true);

    // getPart (single-part path) must agree with the list path.
    expect((await getPart(withSteps)).hasProcessSteps).toBe(true);
    expect((await getPart(none)).hasProcessSteps).toBe(false);
  });

  // Task 15: live orders block part deletion (spec-driven, roadmap Phase 3 Task 15).
  describe("deletePart is guarded by live orders", () => {
    it("refuses while a live order's line references the part — lead or rider — with a "
      + "discoverable, exported blocker list; a voided order blocks neither", async () => {
      const { acme } = await twoCustomers();
      const { id: lead } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "LEAD1", eachWeight: 1 }));
      await giveSteps(lead);
      const { id: rider } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "RIDER1", eachWeight: 1 }));

      const { order } = await asSystem(() => createOrder({
        customerId: acme.id,
        lines: [
          { partId: lead, qty: 10, weight: "100.00" },
          { partId: rider, qty: 5, weight: "50.00" },
        ],
      }));

      // The RIDER, not the lead — "any line, lead or rider" is the point of this guard.
      await expect(asSystem(() => deletePart(rider, "cleanup"))).rejects.toThrow(/live order/i);
      expect(await partOrderBlockers(rider)).toEqual([
        { entityLabel: "Order", name: `#${order.orderNumber} · ACME`, id: order.id, href: `/orders/${order.id}` },
      ]);
      // The lead too — the guard does not special-case position 1.
      await expect(asSystem(() => deletePart(lead, "cleanup"))).rejects.toThrow(/live order/i);

      await asSystem(() => voidOrder(order.id, "test cleanup"));
      // Voided (deletedAt set) blocks nothing — both parts are now freely deletable.
      await asSystem(() => deletePart(rider, "cleanup"));
      await asSystem(() => deletePart(lead, "cleanup"));
      expect((await prisma.part.findFirst({ where: { id: rider } }))!.deletedAt).not.toBeNull();
      expect((await prisma.part.findFirst({ where: { id: lead } }))!.deletedAt).not.toBeNull();
      expect(await partOrderBlockers(rider)).toEqual([]);
    });
  });

  describe("requestDaysOverride", () => {
    it("round-trips through create and update, clears to null, and rejects a negative value", async () => {
      const { acme } = await twoCustomers();
      const { id } = await asSystem(() => createPart({
        customerId: acme.id, partNumber: "RD1", eachWeight: 1, requestDaysOverride: 10,
      }));
      expect((await getPart(id)).requestDaysOverride).toBe(10);

      await asSystem(() => updatePart(id, { requestDaysOverride: 3 }));
      expect((await getPart(id)).requestDaysOverride).toBe(3);

      await asSystem(() => updatePart(id, { requestDaysOverride: null }));
      expect((await getPart(id)).requestDaysOverride).toBeNull();

      await expect(asSystem(() => createPart({
        customerId: acme.id, partNumber: "RD2", eachWeight: 1, requestDaysOverride: -1,
      }))).rejects.toBeInstanceOf(ZodError);
      const { id: id2 } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "RD3", eachWeight: 1 }));
      await expect(asSystem(() => updatePart(id2, { requestDaysOverride: -5 }))).rejects.toBeInstanceOf(ZodError);
    });

    // Fix-wave finding 5: unbounded, this feeds straight into addBusinessDays' own day-at-a-time
    // loop (src/lib/business-days.ts), which now caps at 3650 — bounding it here too means the
    // rejection is a clean 400 at the part edit itself, not a generic error surfaced later at
    // order entry.
    it("rejects a value above the 3650-day cap, and allows exactly the boundary", async () => {
      const { acme } = await twoCustomers();
      await expect(asSystem(() => createPart({
        customerId: acme.id, partNumber: "RD5", eachWeight: 1, requestDaysOverride: 3651,
      }))).rejects.toBeInstanceOf(ZodError);

      const { id } = await asSystem(() => createPart({
        customerId: acme.id, partNumber: "RD6", eachWeight: 1, requestDaysOverride: 3650,
      }));
      expect((await getPart(id)).requestDaysOverride).toBe(3650);
      await expect(asSystem(() => updatePart(id, { requestDaysOverride: 3651 }))).rejects.toBeInstanceOf(ZodError);
    });

    it("shows in the update audit diff", async () => {
      const { acme } = await twoCustomers();
      const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "RD4", eachWeight: 1 }));
      await asSystem(() => updatePart(id, { requestDaysOverride: 7 }));
      const entry = await prisma.auditLog.findFirst({ where: { entity: "part", entityId: id, action: "update" } });
      const before = entry!.before as { requestDaysOverride: number | null };
      const after = entry!.after as { requestDaysOverride: number | null };
      expect(before.requestDaysOverride).toBeNull();
      expect(after.requestDaysOverride).toBe(7);
    });
  });
});
