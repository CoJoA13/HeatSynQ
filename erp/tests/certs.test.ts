import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { readAudit } from "@/server/audit";
import { createOrder, voidOrder, type OrderDetail } from "@/server/orders";
import { resplitLoads } from "@/server/order-loads";
import { addPartInspection } from "@/server/part-inspections";
import {
  createCert, getCert, listCerts, exportCerts, updateCert, voidCert, certsForOrder,
} from "@/server/certs";
import { replaceReadings } from "@/server/cert-results";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import type { CertScopeValue } from "@/lib/cert-constants";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `C${customerSeq}`, name: `Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string, opts: {
  certRequired?: boolean | null; certScope?: CertScopeValue | null; loadQty?: number | null;
} = {}): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: {
      customerId, partNumber: `P-${partSeq}`, eachWeight: "1.0000",
      certRequired: opts.certRequired ?? null, certScope: opts.certScope ?? null,
      loadQty: opts.loadQty ?? null,
    },
  });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the cert-resolution.test.ts precedent. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

/** A live, orderable customer + part, and the ORDER created from it. */
async function savedOrder(opts: {
  certRequired?: boolean | null; certScope?: CertScopeValue | null;
  loadQty?: number | null; qty?: number; poNumber?: string;
} = {}): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  const part = await makePart(customer.id, {
    certRequired: opts.certRequired, certScope: opts.certScope, loadQty: opts.loadQty,
  });
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    poNumber: opts.poNumber ?? "",
    lines: [{ partId: part.id, qty: opts.qty ?? 10, weight: "25.00" }],
  }));
  return { order, part, customer };
}

let shipperSeq = 5000;
/** A minimal, live Shipper + ShipperOrder pairing for `orderId` — raw prisma, on purpose:
 *  shippers.ts (Task 8) does not exist yet, and this file's own SHIPMENT-scope coverage must not
 *  depend on it. */
async function makeShipment(
  customerId: string, orderId: string, sequence: number,
): Promise<{ id: string; shipperNumber: number }> {
  shipperSeq += 1;
  const shipper = await prisma.shipper.create({
    data: { shipperNumber: shipperSeq, customerId, shipDate: new Date() },
  });
  await prisma.shipperOrder.create({
    data: { shipperId: shipper.id, orderId, sequence, position: sequence },
  });
  return shipper;
}

describe("createCert", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("refuses a second live cert for the same scope instance", async () => {
    const { order } = await savedOrder();
    await createCert({ orderId: order.id, scope: "ORDER" });
    await expect(createCert({ orderId: order.id, scope: "ORDER" }))
      .rejects.toThrow(/already has a certification/i);
  });

  it("allows a second cert once the first is voided", async () => {
    const { order } = await savedOrder();
    const first = await createCert({ orderId: order.id, scope: "ORDER" });
    await asSystem(() => voidCert(first.id, "keyed against the wrong load"));
    await expect(createCert({ orderId: order.id, scope: "ORDER" })).resolves.toBeTruthy();
  });

  // Every uniqueness case above is SEQUENTIAL (await the first createCert, then await the
  // second), which proves the business-rule 400 but never exercises `claimOrder`'s row lock at
  // all — a caller that deleted the claim (swapped it for a plain, unlocked `findFirst`) would
  // still pass every test above, since nothing above ever has two transactions open on the same
  // order at once. The real hazard is two genuinely concurrent creates for the SAME
  // scope-instance.
  //
  // Two earlier versions of this test both turned out to prove Postgres's own SSI (Serializable
  // Snapshot Isolation), not `claimOrder`'s row lock — reviewed and diagnosed by hand: swapping
  // `claimOrder` for a bare `findFirst` in `createCertInTx` and re-running left both versions
  // green. With BOTH the competing caller AND every real caller of `createCertInTx` running
  // Serializable, and both doing the identical clash-check SELECT then INSERT on `Cert`, Postgres
  // detects the write-skew on that predicate ALONE — the Order-row lock never has to do anything,
  // so removing it changed nothing observable.
  //
  // The fix (CLAUDE.md's actual point: "the row lock works at ANY caller isolation" is what makes
  // it the guarantee rather than the isolation level) is to take Serializable OFF the table for
  // the competing caller, the `lockCurrentRevision` precedent (part-process-steps.test.ts): call
  // `createCert` directly against a manually-opened, DEFAULT-isolation (Read Committed) `tx`
  // rather than through the public API (which always forces Serializable when no `tx` is passed).
  // Under Read Committed there is no whole-transaction snapshot and no SSI — every statement gets
  // a fresh look at the database — so the ONLY thing that can serialize this call against the
  // holder is `claimOrder`'s row lock itself. That makes the outcome fully deterministic (always
  // exactly the same clean 400, never a legal-either-way race against a 409) and makes the test
  // discriminate for real: verified by hand below (RED with the lock removed, GREEN with it
  // restored — see the task report for both transcripts).
  it("blocks a concurrent create under Read Committed until the holder's cert commits, then refuses on the fresh read (row-lock discipline)", async () => {
    const { order } = await savedOrder();

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // Default (Read Committed) isolation — the `order-loads.test.ts`/`part-process-steps.test.ts`
    // holder precedent exactly. Its own isolation level isn't load-bearing here (SSI is out of
    // the picture on the `createCall` side regardless), only that it takes the row lock, releases
    // it only on commit, and commits a cert while still holding it.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      hasClaimed();
      await release;
      await tx.cert.create({ data: { orderId: order.id, scope: "ORDER" } });
    }, { timeout: 20000 });

    await claimed;
    // Read Committed, NOT Serializable (see the leading comment) — `createCert` called directly
    // against a manually-opened `tx` rather than through the public no-`tx` API.
    const createCall = asSystem(() =>
      prisma.$transaction((tx) => createCert({ orderId: order.id, scope: "ORDER" }, tx)));

    // Not itself the discriminator — its job is to guarantee createCert's own claim attempt has
    // actually been dispatched, and in the correct implementation is genuinely blocked on the
    // holder, before the holder is released. (In the regression — the row lock removed — this call
    // never blocks at all: it reaches its own clash-check instantly, before the holder's cert
    // exists, and resolves with a duplicate almost immediately, so THIS assertion is the one that
    // fails first.)
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      createCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    // The discriminator: with the row lock genuinely in effect, createCert cannot decide anything
    // about this scope-instance until AFTER the holder's cert has committed, and its clash-check
    // — running under Read Committed, so a FRESH per-statement snapshot — must then see it and
    // refuse. Deterministic: always this exact 400, never the Serializable version's legal 400-or-
    // 409 ambiguity, because SSI has nothing to do with this path at all.
    await expect(createCall).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/already has a certification/i),
    });
    expect(await prisma.cert.count({ where: { orderId: order.id, deletedAt: null } })).toBe(1);
  });

  // A supplementary, production-shape confirmation: two genuinely independent callers through the
  // PUBLIC API (both Serializable, no manual synchronization at all) still settle on exactly one
  // live cert. Read this test for what it honestly proves and no more, per the diagnosis above:
  // with both sides Serializable, Postgres's own SSI protects this outcome independently of
  // `claimOrder` — swapping the row lock for a bare `findFirst` does NOT turn this test red (
  // verified by hand). It stays here because it is still true and still worth knowing that real
  // double-submits can't duplicate a cert; the dedicated regression proof for the row lock itself
  // is the Read-Committed test above.
  it("two genuinely concurrent creates through the public API still settle on exactly ONE live cert (not a row-lock regression guard — see comment)", async () => {
    const { order } = await savedOrder();
    const input = { orderId: order.id, scope: "ORDER" as const };

    const settled = await Promise.allSettled([
      asSystem(() => createCert(input)), asSystem(() => createCert(input)),
    ]);

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect([400, 409]).toContain((rejected[0] as PromiseRejectedResult & { reason: { status: number } }).reason.status);

    expect(await prisma.cert.count({ where: { orderId: order.id, deletedAt: null } })).toBe(1);
  });

  it("scopes by load and by shipment independently", async () => {
    const { order } = await savedOrder({ loadQty: 5 }); // qty 10 → loads 1 and 2
    await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 1 });
    await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 2 });
    await expect(createCert({ orderId: order.id, scope: "LOAD", loadNumber: 1 }))
      .rejects.toThrow(/already has a certification/i);
  });

  it("refuses an out-of-int4-range load number with a field 400, not a Prisma 500", async () => {
    const { order } = await savedOrder();
    // The zod bound (handle() maps ZodError to a field 400) — the raw Prisma int4 overflow this
    // used to escape as names no bound and carried no HTTP mapping.
    await expect(createCert({ orderId: order.id, scope: "LOAD", loadNumber: 2147483648 }))
      .rejects.toThrow(/2147483647/);
  });

  it("refuses a LOAD-scope cert for a load the order does not currently have", async () => {
    const { order } = await savedOrder(); // no loadQty cap → exactly one load
    await expect(createCert({ orderId: order.id, scope: "LOAD", loadNumber: 2 }))
      .rejects.toThrow(/does not have a load 2/i);
  });

  it("refuses a cert on a voided order", async () => {
    const { order } = await savedOrder();
    await asSystem(() => voidOrder(order.id, "customer cancelled"));
    await expect(createCert({ orderId: order.id, scope: "ORDER" })).rejects.toThrow(/not found/i);
  });

  it("refuses an unknown order", async () => {
    await expect(createCert({ orderId: "nope", scope: "ORDER" })).rejects.toThrow(/not found/i);
  });

  it("creates a SHIPMENT-scope cert independently per shipper, resolving its sequence and shipper number", async () => {
    const { order, customer } = await savedOrder();
    const shipperA = await makeShipment(customer.id, order.id, 1);
    const shipperB = await makeShipment(customer.id, order.id, 2);

    const certA = await createCert({ orderId: order.id, scope: "SHIPMENT", shipperId: shipperA.id });
    expect(certA.shipperId).toBe(shipperA.id);
    expect(certA.shipperNumber).toBe(shipperA.shipperNumber);
    expect(certA.sequence).toBe(1);

    await expect(createCert({ orderId: order.id, scope: "SHIPMENT", shipperId: shipperA.id }))
      .rejects.toThrow(/already has a certification/i);

    const certB = await createCert({ orderId: order.id, scope: "SHIPMENT", shipperId: shipperB.id });
    expect(certB.sequence).toBe(2);
  });

  // Task 11 Step 0 (carried from Task 8's review): `Shipper` is soft-deletable and `shipperId`
  // carries no `assertRefExists` — a raw foreign key catches a NONEXISTENT id but not a VOIDED
  // one. Safe only while the sole caller (shippers.ts's `saveNewShipper`) passed its own
  // uncommitted row; Task 11 adds the first HTTP-reachable path, so `createCertInTx`'s SHIPMENT
  // branch now checks liveness itself, defense-in-depth, regardless of caller trust.
  it("refuses a voided shipper for SHIPMENT scope", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await makeShipment(customer.id, order.id, 1);
    await prisma.shipper.update({ where: { id: shipper.id }, data: { deletedAt: new Date() } });
    await expect(createCert({ orderId: order.id, scope: "SHIPMENT", shipperId: shipper.id }))
      .rejects.toThrow(/shipperId.*(does not exist|voided)/i);
  });

  describe("per-scope shape", () => {
    it("requires a load number for LOAD scope", async () => {
      const { order } = await savedOrder();
      await expect(createCert({ orderId: order.id, scope: "LOAD" })).rejects.toThrow(/load number/i);
    });

    it("refuses a shipper on a LOAD-scope cert", async () => {
      const { order, customer } = await savedOrder();
      const shipper = await makeShipment(customer.id, order.id, 1);
      await expect(createCert({ orderId: order.id, scope: "LOAD", loadNumber: 1, shipperId: shipper.id }))
        .rejects.toThrow(/shipper/i);
    });

    it("requires a shipper for SHIPMENT scope", async () => {
      const { order } = await savedOrder();
      await expect(createCert({ orderId: order.id, scope: "SHIPMENT" })).rejects.toThrow(/shipper/i);
    });

    it("refuses a load number on a SHIPMENT-scope cert", async () => {
      const { order, customer } = await savedOrder();
      const shipper = await makeShipment(customer.id, order.id, 1);
      await expect(createCert({ orderId: order.id, scope: "SHIPMENT", shipperId: shipper.id, loadNumber: 1 }))
        .rejects.toThrow(/load number/i);
    });

    it("refuses a load number on an ORDER-scope cert", async () => {
      const { order } = await savedOrder();
      await expect(createCert({ orderId: order.id, scope: "ORDER", loadNumber: 1 })).rejects.toThrow(/load number/i);
    });

    it("refuses a shipper on an ORDER-scope cert", async () => {
      const { order, customer } = await savedOrder();
      const shipper = await makeShipment(customer.id, order.id, 1);
      await expect(createCert({ orderId: order.id, scope: "ORDER", shipperId: shipper.id }))
        .rejects.toThrow(/shipper/i);
    });
  });

  it("writes a create audit entry carrying the cert's own fields", async () => {
    const { order } = await savedOrder({ loadQty: 5 }); // qty 10 → loads 1 and 2
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "LOAD", loadNumber: 2 }));
    const [entry] = await readAudit("cert", cert.id);
    expect(entry.action).toBe("create");
    expect(entry.after).toMatchObject({ orderId: order.id, scope: "LOAD", loadNumber: 2, shipperId: null });
  });
});

describe("requirement identity is frozen at seed (ruling 24; round-4 finding)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("keeps the seeded part identity when the part is later renamed", async () => {
    const { order, part } = await savedOrder();
    const code = await prisma.inspectionCode.create({ data: { name: "FRZ-Hardness" } });
    await asSystem(() => addPartInspection(part.id, { inspectionCodeId: code.id, sort: 0, min: 28, max: 32 }));
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    const seeded = cert.requirements[0];

    await prisma.part.update({ where: { id: part.id }, data: { partNumber: "RENAMED-9", name: "Renamed Part" } });

    // min/max/sampleQty/location were always frozen copies — the line identity freezes the same
    // way, whether or not the OrderLine row still exists.
    const after = await getCert(cert.id);
    expect(after.requirements[0].partNumber).toBe(seeded.partNumber);
    expect(after.requirements[0].partNumber).not.toBe("RENAMED-9");
    expect(after.requirements[0].partName).toBe(seeded.partName);
    expect(after.requirements[0].linePosition).toBe(seeded.linePosition);
  });
});

describe("createCert at order save", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("creates an ORDER-scope cert at order save and nothing for the other scopes", async () => {
    const a = await savedOrder({ certRequired: true, certScope: "ORDER" });
    expect(await prisma.cert.count({ where: { orderId: a.order.id } })).toBe(1);
    const b = await savedOrder({ certRequired: true, certScope: "LOAD" });
    expect(await prisma.cert.count({ where: { orderId: b.order.id } })).toBe(0);
    const c = await savedOrder({ certRequired: false, certScope: "ORDER" });
    expect(await prisma.cert.count({ where: { orderId: c.order.id } })).toBe(0);
  });
});

describe("load re-split leaves a load-scope cert untouched", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("leaves the cert live with its loadNumber unchanged after a re-split", async () => {
    const { order } = await savedOrder({ loadQty: 300, qty: 1000 }); // 4 loads
    const cert = await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 3 });

    await asSystem(() => resplitLoads(order.id));

    const after = await getCert(cert.id);
    expect(after.deletedAt).toBeNull();
    expect(after.loadNumber).toBe(3);
  });

  // Task 6's own extension (its brief names this test explicitly): the whole reason load-scope
  // certs are created lazily rather than eagerly is that Phase 3 keeps loads editable and
  // re-splittable, and an eager per-load cert would mean a re-split either orphans certs or
  // destroys ones already holding readings. This proves the "already holding readings" half —
  // a re-split must not touch a cert someone has typed real results into.
  it("survives a re-split with its readings intact", async () => {
    const { order, part } = await savedOrder({ loadQty: 300, qty: 1000 }); // 4 loads
    const code = await prisma.inspectionCode.create({ data: { name: "Brinell" } });
    await asSystem(() => addPartInspection(part.id, { inspectionCodeId: code.id, sort: 0, min: "28", max: "32" }));

    const cert = await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 3 });
    await asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: cert.requirements[0].id, readings: [{ value: "30.0" }] }],
    }, { afterPrint: false }));

    await asSystem(() => resplitLoads(order.id));

    const after = await getCert(cert.id);
    expect(after.deletedAt).toBeNull();
    expect(after.loadNumber).toBe(3);
    expect(after.requirements[0].readings).toHaveLength(1);
    expect(after.requirements[0].readings[0]).toMatchObject({ value: 30, passed: true });
  });
});

describe("getCert", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("returns full detail with poNumber, material, receivedDate and empty defaults", async () => {
    const { order, part } = await savedOrder({ poNumber: "PO-777" });
    await prisma.part.update({ where: { id: part.id }, data: {
      materialId: (await prisma.material.create({ data: { name: "4140" } })).id,
    } });
    const cert = await createCert({ orderId: order.id, scope: "ORDER" });
    const detail = await getCert(cert.id);

    expect(detail.orderId).toBe(order.id);
    expect(detail.orderNumber).toBe(order.orderNumber);
    expect(detail.poNumber).toBe(order.poNumber);
    expect(detail.receivedDate).toBe(order.receivedDate);
    expect(detail.freeform).toBe("");
    expect(detail.internalNotes).toBe("");
    expect(detail.requirements).toEqual([]);
    expect(detail.readingCount).toBe(0);
    expect(detail.failCount).toBe(0);
    expect(detail.sequence).toBeNull();
  });

  it("still reads a voided cert", async () => {
    const { order } = await savedOrder();
    const cert = await createCert({ orderId: order.id, scope: "ORDER" });
    await asSystem(() => voidCert(cert.id, "test void"));
    const after = await getCert(cert.id);
    expect(after.deletedAt).not.toBeNull();
  });

  it("throws 404 for an unknown id", async () => {
    await expect(getCert("nope")).rejects.toThrow(/not found/i);
  });
});

describe("updateCert", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("updates freeform and internalNotes and produces a real before/after audit diff", async () => {
    const { order } = await savedOrder();
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));

    const updated = await asSystem(() => updateCert(cert.id, { freeform: "Heat treated per spec.", internalNotes: "double-checked" }));
    expect(updated.freeform).toBe("Heat treated per spec.");
    expect(updated.internalNotes).toBe("double-checked");

    const [entry] = await readAudit("cert", cert.id);
    expect(entry.action).toBe("update");
    expect((entry.before as { freeform: string }).freeform).toBe("");
    expect((entry.after as { freeform: string }).freeform).toBe("Heat treated per spec.");
  });

  it("throws 404 for an unknown id", async () => {
    await expect(updateCert("nope", { freeform: "x" })).rejects.toThrow(/not found/i);
  });

  // The symmetric case to voidCert's "refuses to void an already-voided cert" below — a voided
  // cert is read-only via getCert (still viewable) but not via updateCert (the updateOrder
  // precedent: a voided order refuses edits the same way).
  it("refuses to update a voided cert", async () => {
    const { order } = await savedOrder();
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    await asSystem(() => voidCert(cert.id, "test void"));
    await expect(asSystem(() => updateCert(cert.id, { freeform: "x" }))).rejects.toThrow(/not found/i);
  });
});

describe("voidCert", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("requires a reason to void", async () => {
    const { order } = await savedOrder();
    const cert = await createCert({ orderId: order.id, scope: "ORDER" });
    await expect(voidCert(cert.id, "   ")).rejects.toThrow(/reason/i);
    await expect(voidCert(cert.id, "")).rejects.toThrow(/reason/i);
  });

  it("sets deletedAt and writes an audit entry whose payload carries the reason", async () => {
    const { order } = await savedOrder();
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));

    await asSystem(() => voidCert(cert.id, "  keyed against the wrong load  "));

    const after = await getCert(cert.id);
    expect(after.deletedAt).not.toBeNull();

    const [entry] = await readAudit("cert", cert.id);
    expect(entry.action).toBe("delete");
    expect(entry.reason).toBe("keyed against the wrong load");
  });

  it("refuses to void an unknown cert", async () => {
    await expect(voidCert("nope", "test")).rejects.toThrow(/not found/i);
  });

  it("refuses to void an already-voided cert", async () => {
    const { order } = await savedOrder();
    const cert = await createCert({ orderId: order.id, scope: "ORDER" });
    await asSystem(() => voidCert(cert.id, "first void"));
    await expect(asSystem(() => voidCert(cert.id, "second void"))).rejects.toThrow(/not found/i);
  });
});

describe("listCerts", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("excludes voided certs by default and includes them when asked", async () => {
    const { order } = await savedOrder();
    const cert = await createCert({ orderId: order.id, scope: "ORDER" });
    await asSystem(() => voidCert(cert.id, "test"));

    expect(await listCerts({})).toEqual([]);
    const withVoided = await listCerts({ includeVoided: true });
    expect(withVoided.map((c) => c.id)).toEqual([cert.id]);
  });

  it("filters by scope, customerId and printed", async () => {
    const a = await savedOrder();
    const b = await savedOrder();
    const orderCert = await createCert({ orderId: a.order.id, scope: "ORDER" });
    const loadCert = await createCert({ orderId: b.order.id, scope: "LOAD", loadNumber: 1 });
    await prisma.cert.update({ where: { id: orderCert.id }, data: { printedAt: new Date() } });

    expect((await listCerts({ scope: "LOAD" })).map((c) => c.id)).toEqual([loadCert.id]);
    expect((await listCerts({ customerId: a.customer.id })).map((c) => c.id)).toEqual([orderCert.id]);
    expect((await listCerts({ printed: true })).map((c) => c.id)).toEqual([orderCert.id]);
    expect((await listCerts({ printed: false })).map((c) => c.id)).toEqual([loadCert.id]);
  });

  it("orders newest-first", async () => {
    const a = await savedOrder();
    const first = await createCert({ orderId: a.order.id, scope: "ORDER" });
    const b = await savedOrder();
    const second = await createCert({ orderId: b.order.id, scope: "ORDER" });

    expect((await listCerts({})).map((c) => c.id)).toEqual([second.id, first.id]);
  });

  it("matches search across order number, PO number and customer code/name", async () => {
    const { order, customer } = await savedOrder({ poNumber: "PO-CERT-1" });
    const cert = await createCert({ orderId: order.id, scope: "ORDER" });

    expect((await listCerts({ search: "PO-CERT-1" })).map((c) => c.id)).toEqual([cert.id]);
    expect((await listCerts({ search: customer.code })).map((c) => c.id)).toEqual([cert.id]);
    expect((await listCerts({ search: String(order.orderNumber) })).map((c) => c.id)).toEqual([cert.id]);
    expect(await listCerts({ search: "no-such-thing-zzz" })).toEqual([]);
  });
});

describe("exportCerts", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  async function sheetOf(buf: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    return wb.getWorksheet("Certifications")!;
  }

  it("writes the cert columns with a header row and one row per cert", async () => {
    const { order } = await savedOrder({ loadQty: 3 }); // qty 10 -> loads 1..4
    await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 4 });

    const sheet = await sheetOf(await exportCerts({}));
    // Passed and Pending ride beside Readings/Fails — a row of 10 readings all still pending must
    // not read as 10 passing (the worklist's own three-state rule, exported).
    expect(sheet.getRow(1).values).toEqual([undefined,
      "Order #", "Seq", "Customer code", "Customer name", "Scope", "Load #", "Shipper #",
      "Printed", "Readings", "Passed", "Fails", "Pending", "Voided"]);
    const cells = (n: number) => sheet.getRow(2).getCell(n).value;
    expect(cells(1)).toBe(order.orderNumber);
    expect(cells(5)).toBe("LOAD");
    expect(cells(6)).toBe(4);
    expect(cells(8)).toBe("no");
    expect(cells(9)).toBe(0);
    expect(cells(10)).toBe(0);
    expect(cells(11)).toBe(0);
    expect(cells(12)).toBe(0);
    expect(cells(13)).toBe("no");
    expect(sheet.rowCount).toBe(2);
  });
});

// Fix-wave (whole-branch review 2026-08-06, Important #1): the guarded state (`Cert.deletedAt`)
// lives on the Cert row, NOT on the Order row `claimCertsOrder` claims — so the void-vs-mutate
// serialization has to come from a lock on the Cert row itself, never from SSI. The T5 technique
// from the createCert race test above, applied to the void interleaving: the VOIDER is a
// manually-scripted DEFAULT-isolation (Read Committed) transaction, which takes Postgres's SSI
// entirely off the table (SSI only serializes transactions that are ALL Serializable — CLAUDE.md),
// so the ONLY thing that can stop `replaceReadings` writing through a void that committed while it
// was blocked on the order lock is `claimCertsOrder`'s own FOR UPDATE on the Cert row. Verified
// RED against the pre-fix code (claimCertsOrder locking the Order row alone): `replaceReadings`
// resolved successfully and wrote a reading onto the voided cert — the fix-wave report carries the
// transcript.
describe("voided-state guard rides the Cert row lock, not SSI (fix-wave Important #1)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("replaceReadings racing a Read-Committed voidCert never writes readings through a void that committed while it was blocked", async () => {
    const customer = await makeCustomer();
    const part = await makePart(customer.id);
    await giveSteps(part.id);
    const code = await prisma.inspectionCode.create({ data: { name: "Hardness-race" } });
    await asSystem(() => addPartInspection(part.id, { inspectionCodeId: code.id, sort: 0 }));
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "",
      lines: [{ partId: part.id, qty: 10, weight: "25.00" }],
    }));
    const cert = await createCert({ orderId: order.id, scope: "ORDER" });
    const requirementId = cert.requirements[0].id;

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // The voider: `voidCert`'s own claim-then-write sequence, scripted at DEFAULT (Read Committed)
    // isolation. It signals ONLY once its FOR UPDATE is actually held (the real happens-before
    // edge — never a sleep), then commits the void while the competitor is still blocked on that
    // same order lock.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      hasClaimed();
      await release;
      await tx.cert.update({ where: { id: cert.id }, data: { deletedAt: new Date() } });
    }, { timeout: 20000 });

    await claimed;
    const replaceCall = asSystem(() => replaceReadings(cert.id, {
      requirements: [{ id: requirementId, readings: [{ value: 42 }] }],
    }, { afterPrint: false }));

    // Not itself the discriminator (the createCert race test's own probe shape): its job is to
    // guarantee replaceReadings' claim attempt has been dispatched and is genuinely blocked on the
    // holder before the void is released.
    const TIMED_OUT = Symbol("timed out");
    const raceResult = await Promise.race([
      replaceCall.then(() => "settled" as const, () => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ]);
    expect(raceResult).toBe(TIMED_OUT);

    mayRelease();
    await holder;

    // The discriminator. With the Cert row locked by claimCertsOrder, the Serializable competitor's
    // FOR UPDATE on the now-updated Cert row raises 40001, which withDbErrors maps to its honest
    // "try again" 409 — and, decisively, NO reading is ever written onto the voided cert. Pre-fix
    // (Order row lock alone) the call resolves: its Serializable snapshot was fixed before the void
    // committed, so the post-claim re-read could not see `deletedAt` and the write went through.
    await expect(replaceCall).rejects.toMatchObject({ status: 409 });
    expect(await prisma.certReading.count({ where: { requirementId } })).toBe(0);
    const after = await prisma.cert.findFirst({ where: { id: cert.id } });
    expect(after?.deletedAt).not.toBeNull();
  });
});

describe("certsForOrder", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("returns every cert for the order, voided included", async () => {
    const { order } = await savedOrder({ loadQty: 5 }); // qty 10 -> loads 1 and 2
    const live = await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 1 });
    const voided = await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 2 });
    await asSystem(() => voidCert(voided.id, "test"));

    const rows = await certsForOrder(order.id);
    expect(rows.map((r) => r.id).sort()).toEqual([live.id, voided.id].sort());
  });

  it("does not return another order's certs", async () => {
    const a = await savedOrder();
    const b = await savedOrder();
    await createCert({ orderId: a.order.id, scope: "ORDER" });
    expect(await certsForOrder(b.order.id)).toEqual([]);
  });
});
