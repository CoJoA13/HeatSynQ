import { describe, it, expect, beforeEach } from "vitest";
import { ZodError } from "zod";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import {
  createPart, updatePart, deletePart, getPart, listParts, partOrderBlockers, partQuoteBlockers,
} from "@/server/parts";
import { createOrder, voidOrder } from "@/server/orders";
import { addAttachment } from "@/server/attachments";
import { setSetting } from "@/server/settings";
import { addPartPrice } from "@/server/part-prices";

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
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

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
      materialName: "Ductile iron", eachWeight: 2.5, active: true,
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
      customerId: acme.id, partNumber: "A", eachWeight: "0.0500",
    }));
    expect((await getPart(id)).eachWeight).toBe(0.05);
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

  it("delete requires a reason and cascades children in one transaction", async () => {
    const { acme } = await twoCustomers();
    const spec = await prisma.specification.create({ data: { name: "ASTM A536" } });
    const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "D", eachWeight: 1 }));
    await prisma.partSpecification.create({ data: { partId: id, specificationId: spec.id } });
    // Fix-wave R3 finding 5: the cascade used to soft-delete specifications/inspections/price
    // breaks but not attachments — rows stayed live yet unreachable behind the live-part guard
    // every attachment operation requires (assertOwnerVisible, attachments.ts). Include an
    // attachment here so this same "cascades children in one transaction" test also pins it.
    const { id: attId } = await asSystem(() => addAttachment("part", id, {
      filename: "drawing.pdf", mimeType: "application/pdf", data: Buffer.from("pdf-bytes"),
    }));
    // Task 2 changed `deletePart` to cascade-soft-delete PartPrice rows (parts.ts) and left it
    // untested. It is load-bearing: `partPrice` reuses PART_VIA_CHILD in the FK registry, so if
    // the cascade were ever dropped, a deleted part's live price rows would block a step-code
    // delete forever behind a blocker naming a part nobody can see.
    const code = await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
    const { id: priceId } = await asSystem(() => addPartPrice(id, { processStepCodeId: code.id, position: 1 }));
    await expect(asSystem(() => deletePart(id, "  "))).rejects.toThrow("A reason is required");
    await asSystem(() => deletePart(id, "keyed wrong"));
    expect((await prisma.part.findFirst({ where: { id } }))!.deletedAt).not.toBeNull();
    expect((await prisma.partSpecification.findFirst({ where: { partId: id } }))!.deletedAt).not.toBeNull();
    const attachment = await prisma.partAttachment.findFirst({ where: { id: attId } });
    expect(attachment!.deletedAt).not.toBeNull();
    // Its breaks are deliberately left alone — they hang off a dead row under a dead part and no
    // live read can reach them (deletePartPrice follows the same rule).
    const price = await prisma.partPrice.findUniqueOrThrow({ where: { id: priceId } });
    expect(price.deletedAt).not.toBeNull();
    const entry = await prisma.auditLog.findFirst({ where: { entity: "part", entityId: id, action: "delete" } });
    expect(entry!.reason).toBe("keyed wrong");
    const attEntry = await prisma.auditLog.findFirst({
      where: { entity: "partAttachment", entityId: attId, action: "delete" },
    });
    expect(attEntry!.reason).toBe("parent part deleted");
    const priceEntry = await prisma.auditLog.findFirst({
      where: { entity: "partPrice", entityId: priceId, action: "delete" },
    });
    expect(priceEntry!.reason).toBe("parent part deleted");
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

  // Task 7 (Phase 6 spec §4.2/§7): live quote lines block part deletion the same way live orders
  // do — a part-linked quote line reads its printed identity (number/name/description/material/
  // weight) live from the part, so deleting the part would hollow out a still-live agreement.
  // Raw-prisma quote fixtures for the same reason giveSteps is raw: parts.ts's guard must not be
  // proven through quotes.ts's own validation.
  describe("deletePart is guarded by live quotes", () => {
    async function quoteOn(customerId: string, partId: string, quoteNumber: number,
                           extra: Record<string, unknown> = {}) {
      const user = await prisma.user.findFirst({ where: { username: "quoter-fixture" } })
        ?? await prisma.user.create({
          data: { username: "quoter-fixture", passwordHash: "x", displayName: "Quoter" } });
      return prisma.quote.create({
        data: {
          quoteNumber, customerId, quotedById: user.id,
          quoteDate: new Date("2026-08-01"), effectiveDate: new Date("2026-08-01"),
          expiryDate: new Date("2026-08-31"),
          lines: { create: [{ position: 1, partId }] },
          ...extra,
        },
        include: { lines: true },
      });
    }

    it("refuses while a live quote's live line references the part — OPEN or CLOSED — with a "
      + "discoverable blocker list named the Quote way", async () => {
      const { acme } = await twoCustomers();
      const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "Q1", eachWeight: 1 }));
      const open = await quoteOn(acme.id, id, 1000);
      // CLOSED is not deleted: the agreement's record survives closing, so it still blocks —
      // "live" in §5.14 means deletedAt null, never a status.
      const closed = await quoteOn(acme.id, id, 1001,
        { status: "CLOSED", closeReason: "went elsewhere", closedAt: new Date() });

      await expect(asSystem(() => deletePart(id, "cleanup"))).rejects.toThrow(/live quote/i);
      expect(await partQuoteBlockers(id)).toEqual([
        { entityLabel: "Quote", name: "Quote · #1000", id: open.id, href: `/quotes/${open.id}` },
        { entityLabel: "Quote", name: "Quote · #1001", id: closed.id, href: `/quotes/${closed.id}` },
      ]);
      // Refused, not allowed-and-dangled — the part survives.
      expect((await prisma.part.findFirst({ where: { id } }))!.deletedAt).toBeNull();
    });

    it("the refusal counts QUOTES, not lines, so the message and the panel never disagree", async () => {
      const { acme } = await twoCustomers();
      const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "Q2", eachWeight: 1 }));
      // Two live lines on ONE quote referencing the same part — unreachable through the quote
      // service (one-live-line-per-part rule) but not indexed, so the guard must not trust it.
      const q = await quoteOn(acme.id, id, 1002);
      await prisma.quoteLine.create({ data: { quoteId: q.id, position: 2, partId: id } });

      await expect(asSystem(() => deletePart(id, "cleanup")))
        .rejects.toThrow("That part is quoted on 1 live quote(s)");
      expect(await partQuoteBlockers(id)).toHaveLength(1);
    });

    it("a deleted quote's lines, and a line removed from a live quote, block nothing — the part "
      + "then deletes cleanly", async () => {
      const { acme } = await twoCustomers();
      const { id: viaDeadQuote } = await asSystem(() =>
        createPart({ customerId: acme.id, partNumber: "Q3", eachWeight: 1 }));
      const { id: viaDeadLine } = await asSystem(() =>
        createPart({ customerId: acme.id, partNumber: "Q4", eachWeight: 1 }));

      // deleteQuote's own shape: the quote stamped AND its lines stamped with it.
      const dead = await quoteOn(acme.id, viaDeadQuote, 1003, { deletedAt: new Date() });
      await prisma.quoteLine.updateMany({ where: { quoteId: dead.id }, data: { deletedAt: new Date() } });
      // A line edited out of a live quote: the line is stamped, the quote lives on.
      const live = await quoteOn(acme.id, viaDeadLine, 1004);
      await prisma.quoteLine.updateMany({ where: { quoteId: live.id }, data: { deletedAt: new Date() } });

      expect(await partQuoteBlockers(viaDeadQuote)).toEqual([]);
      expect(await partQuoteBlockers(viaDeadLine)).toEqual([]);
      await asSystem(() => deletePart(viaDeadQuote, "cleanup"));
      await asSystem(() => deletePart(viaDeadLine, "cleanup"));
      expect((await prisma.part.findFirst({ where: { id: viaDeadQuote } }))!.deletedAt).not.toBeNull();
      expect((await prisma.part.findFirst({ where: { id: viaDeadLine } }))!.deletedAt).not.toBeNull();
    });

    // Belt-and-braces for deleteQuote's own belt: a quote soft-deleted while its lines were
    // (wrongly) left live must still not block from the grave — the guard walks the CHAIN.
    it("a live-looking line under a soft-deleted quote does not block", async () => {
      const { acme } = await twoCustomers();
      const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "Q5", eachWeight: 1 }));
      await quoteOn(acme.id, id, 1005, { deletedAt: new Date() }); // lines stay unstamped
      expect(await partQuoteBlockers(id)).toEqual([]);
      await asSystem(() => deletePart(id, "cleanup"));
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

  // Phase 7 Task 15: processName is presentation vocabulary (spec §5.7 ruling 4) — the traveler
  // prints it live and the invoice snapshots it at create; both already built. This surfaces it
  // for data entry, so the service must accept it as optional display text (the parts convention:
  // required identifiers use .trim().min(1), optional display text uses .max(n) defaulting "").
  describe("processName", () => {
    it("round-trips through create and update, defaults to \"\" when omitted, and audits a real diff", async () => {
      const { acme } = await twoCustomers();

      // Omitted on create → the DB default "", not null (the optional/empty-default shape).
      const { id } = await asSystem(() =>
        createPart({ customerId: acme.id, partNumber: "PN1", eachWeight: 1 }));
      expect((await getPart(id)).processName).toBe("");

      // Provided on create → persists verbatim.
      const { id: seeded } = await asSystem(() => createPart({
        customerId: acme.id, partNumber: "PN0", eachWeight: 1, processName: "Nitride",
      }));
      expect((await getPart(seeded)).processName).toBe("Nitride");

      // First update sets it: the "" → "Austemper" diff must show in the audit history.
      await asSystem(() => updatePart(id, { processName: "Austemper" }));
      expect((await getPart(id)).processName).toBe("Austemper");

      await asSystem(() => updatePart(id, { processName: "Carburize" }));
      expect((await getPart(id)).processName).toBe("Carburize");

      // Cleared back to "" (blank stays "", never null).
      await asSystem(() => updatePart(id, { processName: "" }));
      expect((await getPart(id)).processName).toBe("");

      const entry = await prisma.auditLog.findFirst({
        where: { entity: "part", entityId: id, action: "update" }, orderBy: { at: "asc" },
      });
      const before = entry!.before as { processName: string };
      const after = entry!.after as { processName: string };
      expect(before.processName).toBe("");
      expect(after.processName).toBe("Austemper");
    });

    it("rejects a too-long value, field-anchored to processName", async () => {
      const { acme } = await twoCustomers();
      const tooLong = "x".repeat(201);
      const err = await asSystem(() => createPart({
        customerId: acme.id, partNumber: "PN2", eachWeight: 1, processName: tooLong,
      })).catch((e) => e);
      expect(err).toBeInstanceOf(ZodError);
      expect((err as ZodError).issues[0].path).toEqual(["processName"]);
    });
  });

  // Task 4 wiring: the update schema accepts certRequired/certScope, and null (inherit) stays
  // distinct from an explicit false (the part's own "no cert") end to end — resolveCertSettings
  // (certs.ts, tests/cert-resolution.test.ts) is what actually WALKS this chain; this only pins
  // that the part's own half of it round-trips through create/update/getPart untouched.
  describe("certRequired / certScope", () => {
    it("round-trips through create and update, and clears back to null (inherit)", async () => {
      const { acme } = await twoCustomers();
      const { id } = await asSystem(() => createPart({
        customerId: acme.id, partNumber: "CT1", eachWeight: 1, certRequired: true, certScope: "LOAD",
      }));
      expect(await getPart(id)).toMatchObject({ certRequired: true, certScope: "LOAD" });

      await asSystem(() => updatePart(id, { certRequired: false, certScope: "SHIPMENT" }));
      expect(await getPart(id)).toMatchObject({ certRequired: false, certScope: "SHIPMENT" });

      await asSystem(() => updatePart(id, { certRequired: null, certScope: null }));
      expect(await getPart(id)).toMatchObject({ certRequired: null, certScope: null });
    });

    it("defaults to null (inherit) when omitted on create", async () => {
      const { acme } = await twoCustomers();
      const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "CT2", eachWeight: 1 }));
      expect(await getPart(id)).toMatchObject({ certRequired: null, certScope: null });
    });

    // Task 17: the part page's three-state control shows what "inherit" currently resolves to
    // (customer default, else plant setting) without the client needing a settings seam of its
    // own. Display-only companion values — the part's own columns stay the unresolved override.
    it("reports what a null column would inherit: the customer default, else the plant setting", async () => {
      await setSetting("cert_required_default", false);
      await setSetting("cert_scope_default", "ORDER");
      const { acme } = await twoCustomers();
      await prisma.customer.update({
        where: { id: acme.id }, data: { certRequiredDefault: true, certScopeDefault: "LOAD" },
      });
      const { id } = await asSystem(() => createPart({ customerId: acme.id, partNumber: "CT3", eachWeight: 1 }));
      expect(await getPart(id)).toMatchObject({ inheritedCertRequired: true, inheritedCertScope: "LOAD" });

      // The part's OWN override never moves the inherited display values.
      await asSystem(() => updatePart(id, { certRequired: false, certScope: "SHIPMENT" }));
      expect(await getPart(id)).toMatchObject({
        certRequired: false, certScope: "SHIPMENT",
        inheritedCertRequired: true, inheritedCertScope: "LOAD",
      });

      // Customer inheriting too → the plant settings show through, on the list row as well.
      await prisma.customer.update({
        where: { id: acme.id }, data: { certRequiredDefault: null, certScopeDefault: null },
      });
      const row = (await listParts()).find((r) => r.id === id);
      expect(row).toMatchObject({ inheritedCertRequired: false, inheritedCertScope: "ORDER" });
    });
  });
});
