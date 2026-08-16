import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { readAudit } from "@/server/audit";
import { createOrder, getOrder, updateOrder, type OrderDetail } from "@/server/orders";
import { createShipper, getShipper, voidShipper, type ShipperCreateResult } from "@/server/shippers";
import type { Customer, Part } from "../prisma/generated/prisma/client";
import type { CertScopeValue } from "@/lib/cert-constants";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(opts: { creditHold?: boolean } = {}): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `C${customerSeq}`, name: `Customer ${customerSeq}`, creditHold: opts.creditHold ?? false },
  });
}

let partSeq = 0;
async function makePart(customerId: string, opts: {
  certRequired?: boolean | null; certScope?: CertScopeValue | null; serializationRequired?: boolean;
} = {}): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: {
      customerId, partNumber: `P-${partSeq}`, eachWeight: "1.0000",
      certRequired: opts.certRequired ?? null, certScope: opts.certScope ?? null,
      serializationRequired: opts.serializationRequired ?? false,
    },
  });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the certs.test.ts/ship-ledger.test.ts precedent. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

/** A live, orderable customer + part, and the ORDER created from it (the certs.test.ts
 *  `savedOrder` precedent). `certScope` defaults to `"LOAD"`, not `null` (which would resolve to
 *  the plant default, `"ORDER"`), whenever `certRequired` is requested: orders.ts's own
 *  `saveNewOrder` creates an ORDER-scope cert automatically at save, which would leave nothing
 *  "missing" for the missing-cert warning tests below to observe. LOAD-scope certs are the one
 *  scope Phase 4 never creates eagerly (spec §6.2, owner ruling §3.17) — the scope that actually
 *  produces the gap spec §5.7's first warning describes. */
async function savedOrder(opts: {
  creditHold?: boolean; certRequired?: boolean; certScope?: CertScopeValue; serializationRequired?: boolean;
  qty?: number; weight?: string; poNumber?: string;
} = {}): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer({ creditHold: opts.creditHold });
  const part = await makePart(customer.id, {
    certRequired: opts.certRequired ?? null,
    certScope: opts.certRequired ? (opts.certScope ?? "LOAD") : (opts.certScope ?? null),
    serializationRequired: opts.serializationRequired,
  });
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    poNumber: opts.poNumber ?? "",
    lines: [{ partId: part.id, qty: opts.qty ?? 10, weight: opts.weight ?? "25.00" }],
  }));
  return { order, part, customer };
}

/** An order with TWO lines — the add-line picker's own fixture: one line goes on the shipment and
 *  the OTHER stays a candidate for it, which is the case task-14-brief.md's "prefilled to the
 *  remainder" actually turns on (a candidate already partly shipped elsewhere). `savedOrder` above
 *  only ever makes a single-line order, so the candidate case has no fixture without this one. */
async function twoLineOrder(): Promise<{ order: OrderDetail; customer: Customer }> {
  const customer = await makeCustomer();
  const firstPart = await makePart(customer.id);
  const secondPart = await makePart(customer.id);
  await giveSteps(firstPart.id);
  await giveSteps(secondPart.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    lines: [
      { partId: firstPart.id, qty: 10, weight: "25.00" },
      { partId: secondPart.id, qty: 8, weight: "12.00" },
    ],
  }));
  return { order, customer };
}

/** Shape of one `createShipper` input's container/serial entries — typed properly (not
 *  `unknown[]`) so the tests that mutate `input.orders[0].containers`/`.serials` in place stay
 *  type-checked rather than opting out of it (Task 8 review, 2026-08-04). */
type ShipContainerInput = { orderContainerId: string; count: number };
type ShipSerialInput = { orderSerialId: string; printOnShipper?: boolean };

/** The minimal legal `createShipper` input for one order, shipping its one lead line in full —
 *  no containers, no serials. */
function oneOrderInput(order: OrderDetail) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
        lineComplete: false,
      }],
      containers: [] as ShipContainerInput[],
      serials: [] as ShipSerialInput[],
    }],
  };
}

/** `oneOrderInput` with the caller choosing which of the order's lines ship, and how much — the
 *  multi-line/multi-shipment fixture the ledger tests below need. */
function shipmentOf(order: OrderDetail, lines: { orderLineId: string; qty: number; weight: number }[]) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: lines.map((l) => ({ ...l, lineComplete: false })),
      containers: [] as ShipContainerInput[],
      serials: [] as ShipSerialInput[],
    }],
  };
}

/** `oneOrderInput`, but the one line ships zero quantity — the "a document about nothing is not a
 *  shipment" refusal (spec §4.2). */
function zeroQtyInput(order: OrderDetail) {
  return {
    customerId: order.customerId,
    shipDate: "2026-08-04",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: 0, weight: 0, lineComplete: false }],
      containers: [] as ShipContainerInput[],
      serials: [] as ShipSerialInput[],
    }],
  };
}

describe("createShipper", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("blocks a customer on credit hold and names them", async () => {
    const { order, customer } = await savedOrder({ creditHold: true });
    await expect(createShipper(oneOrderInput(order), { canOverrideCreditHold: false }))
      .rejects.toThrow(new RegExp(`${customer.name}.*credit hold`, "i"));
  });

  it("allows the override with a reason and records it in the audit entry", async () => {
    const { order } = await savedOrder({ creditHold: true });
    const { shipper } = await createShipper(
      { ...oneOrderInput(order), creditHoldReason: "owner approved, cheque in hand" },
      { canOverrideCreditHold: true });
    const entry = await prisma.auditLog.findFirst({ where: { entity: "shipper", entityId: shipper.id } });
    expect(JSON.stringify(entry)).toContain("cheque in hand");
  });

  it("refuses the override with a blank reason", async () => {
    const { order } = await savedOrder({ creditHold: true });
    await expect(createShipper({ ...oneOrderInput(order), creditHoldReason: "  " },
      { canOverrideCreditHold: true })).rejects.toThrow(/reason/i);
  });

  it("returns the first shipment for a repeated clientRequestId", async () => {
    const { order } = await savedOrder();
    const input = { ...oneOrderInput(order), clientRequestId: "nonce-1" };
    const a = await createShipper(input, { canOverrideCreditHold: false });
    const b = await createShipper(input, { canOverrideCreditHold: false });
    expect(b.deduped).toBe(true);
    expect(b.shipper.id).toBe(a.shipper.id);
    expect(await prisma.shipper.count()).toBe(1);
  });

  it("recomputes creation warnings on an idempotent replay (#50)", async () => {
    const { order } = await savedOrder({ certRequired: true }); // LOAD default — no cert exists
    const input = { ...oneOrderInput(order), clientRequestId: "nonce-warn" };
    const a = await createShipper(input, { canOverrideCreditHold: false });
    expect(a.warnings.join(" ")).toMatch(/requires a certification/i);

    // The lost-response retry the nonce exists for must not silently drop the advisory surface.
    const b = await createShipper(input, { canOverrideCreditHold: false });
    expect(b.deduped).toBe(true);
    expect(b.warnings.join(" ")).toMatch(/requires a certification/i);
  });

  it("warns without blocking on a missing cert and unserialised lines", async () => {
    const { order } = await savedOrder({ certRequired: true, serializationRequired: true });
    const { warnings } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
    expect(warnings.join(" ")).toMatch(/requires a certification/i);
    expect(warnings.join(" ")).toMatch(/no serial numbers/i);
  });

  it("warns when the REQUIRED scope's cert is missing though a stale other-scope cert is live (#53)", async () => {
    // ORDER cert auto-created at order save; the scope override to LOAD leaves it live (that is
    // deliberate) — but it must not satisfy a LOAD requirement nothing has created yet.
    const { order } = await savedOrder({ certRequired: true, certScope: "ORDER" });
    await asSystem(() => updateOrder(order.id, { certScope: "LOAD" }));
    const { warnings } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
    expect(warnings.join(" ")).toMatch(/requires a certification/i);
  });

  it("refuses a shipment with no positive quantity", async () => {
    const { order } = await savedOrder();
    await expect(createShipper(zeroQtyInput(order), { canOverrideCreditHold: false }))
      .rejects.toThrow(/at least one line/i);
  });

  it("does not warn once a serial is selected for a serialization-required line", async () => {
    const { order } = await savedOrder({ serializationRequired: true });
    const serial = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "S-1", description: "" },
    });
    const input = oneOrderInput(order);
    input.orders[0].serials = [{ orderSerialId: serial.id, printOnShipper: true }];
    const { warnings } = await createShipper(input, { canOverrideCreditHold: false });
    expect(warnings.join(" ")).not.toMatch(/no serial numbers/i);
  });

  it("warns, but still saves, when a line ships more than its remaining quantity", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const input = oneOrderInput(order);
    input.orders[0].lines[0].qty = 999;
    const { warnings, shipper } = await createShipper(input, { canOverrideCreditHold: false });
    expect(warnings.join(" ")).toMatch(/exceeds/i);
    expect(shipper.orders[0].lines[0].qty).toBe(999);
  });

  it("creates a SHIPMENT-scope cert for every order whose resolved scope is SHIPMENT, and none otherwise", async () => {
    const withShipmentCert = await savedOrder({ certRequired: true, certScope: "SHIPMENT" });
    const withoutCert = await savedOrder();

    const { shipper: a } = await createShipper(oneOrderInput(withShipmentCert.order), { canOverrideCreditHold: false });
    expect(await prisma.cert.count({ where: { orderId: withShipmentCert.order.id, shipperId: a.id } })).toBe(1);

    const { shipper: b } = await createShipper(oneOrderInput(withoutCert.order), { canOverrideCreditHold: false });
    expect(await prisma.cert.count({ where: { shipperId: b.id } })).toBe(0);
  });

  it("moves the order to PARTIAL_SHIPPED and stamps sequence 1 and label", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
    expect(shipper.orders[0].sequence).toBe(1);
    expect(shipper.orders[0].label).toBe(`${order.orderNumber}-1`);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(after.status).toBe("PARTIAL_SHIPPED");
  });

  it("refuses an unknown order", async () => {
    const { order } = await savedOrder();
    const input = oneOrderInput(order);
    input.orders[0].orderId = "nope";
    await expect(createShipper(input, { canOverrideCreditHold: false })).rejects.toThrow(/not found/i);
  });

  it("refuses a line that does not belong to the named order", async () => {
    const a = await savedOrder();
    const b = await savedOrder();
    const input = oneOrderInput(a.order);
    input.orders[0].lines[0].orderLineId = b.order.lines[0].id;
    await expect(createShipper(input, { canOverrideCreditHold: false }))
      .rejects.toThrow(/does not belong/i);
  });

  // A repeated child id within one order must be refused BY NAME, in the service — never left to
  // fall through to the database's `@@unique` constraint, where `withDbErrors`' generic
  // `conflictField: "shipper number"` would mislabel it as a numbering collision (Task 8 review,
  // 2026-08-04).
  it("refuses a duplicate order line within one shipment, naming it", async () => {
    const { order } = await savedOrder({ qty: 10 });
    const input = oneOrderInput(order);
    input.orders[0].lines.push({ ...input.orders[0].lines[0] });
    await expect(createShipper(input, { canOverrideCreditHold: false }))
      .rejects.toThrow(/line 1.*listed twice/i);
  });

  it("refuses a duplicate container within one shipment, naming it", async () => {
    const { order } = await savedOrder();
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const container = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: containerType.id, count: 2 },
    });
    const input = oneOrderInput(order);
    input.orders[0].containers = [
      { orderContainerId: container.id, count: 1 },
      { orderContainerId: container.id, count: 1 },
    ];
    await expect(createShipper(input, { canOverrideCreditHold: false }))
      .rejects.toThrow(/Basket.*listed twice/i);
  });

  it("refuses a duplicate serial within one shipment, naming it", async () => {
    const { order } = await savedOrder();
    const serial = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "S-42", description: "" },
    });
    const input = oneOrderInput(order);
    input.orders[0].serials = [{ orderSerialId: serial.id }, { orderSerialId: serial.id }];
    await expect(createShipper(input, { canOverrideCreditHold: false }))
      .rejects.toThrow(/S-42.*listed twice/i);
  });

  it("writes a create audit entry naming the customer by code, not only by cuid", async () => {
    const { order, customer } = await savedOrder();
    const { shipper } = await createShipper(oneOrderInput(order), { canOverrideCreditHold: false });
    const [entry] = await readAudit("shipper", shipper.id);
    expect(entry.action).toBe("create");
    // The cuid legitimately still rides along (`customerId`, a real reference) — the point is
    // that a human-readable name is ALSO present, not that the id is scrubbed.
    expect((entry.after as { customerCode?: string }).customerCode).toBe(customer.code);
    expect((entry.after as { customerName?: string }).customerName).toBe(customer.name);
  });

  // ---------------------------------------------------------------------------------------
  // Concurrency (spec §5.3, task-8-brief.md Step 7). Both drive `createShipper` itself — the
  // real public API, always Serializable — rather than a manually-opened `tx`: createShipper
  // takes no `tx` parameter (unlike createCert), so there is no way to reproduce certs.test.ts's
  // Read-Committed-holder trick against this function without changing its public signature. See
  // the task report for the hand-verified RED/GREEN transcripts of swapping `claimOrdersInOrder`
  // for an unsorted per-id loop in `saveNewShipper`'s own call site.
  // ---------------------------------------------------------------------------------------

  // Two genuinely concurrent creates through the PUBLIC API, both Serializable, racing on the
  // SAME order row AND the same `shipper_number_next` counter row — both are FOR UPDATE row
  // locks, so the two transactions serialize rather than corrupt each other, but Postgres's own
  // SSI can still abort the second-to-commit side with a 40001 the instant it detects the
  // resulting read/write dependency (`createOrder`'s own docstring, orders.ts, and the
  // `orders.test.ts` `createConcurrently` precedent this file's `ship-ledger.test.ts` sibling
  // cites: "documents this exact, expected 409"). The number/sequence pair is never corrupted
  // either way — this is the `certs.test.ts` "supplementary, production-shape confirmation"
  // shape, not a deterministic row-lock regression guard (see that file's own comment on why): it
  // proves two real double-submits can't duplicate a number or a sequence, honestly allowing for
  // the legitimate 409 retry signal on the losing side.
  it("two concurrent shipments against the SAME order never collide on a packing-list number or a sequence (not a deterministic row-lock regression guard — see comment)", async () => {
    const { order } = await savedOrder({ qty: 20 });
    const input = oneOrderInput(order);
    input.orders[0].lines[0].qty = 5;

    const settled = await Promise.allSettled([
      createShipper(input, { canOverrideCreditHold: false }),
      createShipper(input, { canOverrideCreditHold: false }),
    ]);

    for (const result of settled) {
      if (result.status === "rejected") {
        expect((result.reason as { status?: number }).status).toBe(409); // a retry signal, never a 500
      }
    }
    const fulfilled = settled.filter((r): r is PromiseFulfilledResult<ShipperCreateResult> => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    if (fulfilled.length === 2) {
      expect(fulfilled[0].value.shipper.shipperNumber).not.toBe(fulfilled[1].value.shipper.shipperNumber);
      expect(fulfilled[0].value.shipper.orders[0].sequence).not.toBe(fulfilled[1].value.shipper.orders[0].sequence);
    }
  });

  // The hazard spec §5.3 names directly: two multi-order saves touching {A,B} and {B,A} deadlock
  // if each claims its orders in its OWN (caller) order. `createShipper` claims through
  // `claimOrdersInOrder` (order-locks.ts), already proven deadlock-free by
  // ship-ledger.test.ts's own `claimOrdersInOrder` suite; this test proves THIS service's call
  // site actually uses it, rather than looping `claimOrder` per id in caller order.
  //
  // Verified by hand both ways (task-8 review, 2026-08-04), against a temporary probe that
  // swapped `claimOrdersInOrder` for the exact anti-pattern spec §5.3 names — an unsorted loop of
  // per-id `claimOrder` calls in caller order:
  //  - WITH a 50ms delay inserted between the loop's two claims (to force the interleaving
  //    window open): reliably RED — a genuine Postgres `deadlock detected` (40P01), untranslated,
  //    would surface as a 500 in production.
  //  - WITHOUT that delay: GREEN 5/5 repeats. This local Postgres is fast enough that one side's
  //    whole two-statement loop usually finishes before the other side's first statement lands,
  //    so the naive loop alone is not a reliable trigger — the identical finding
  //    `ship-ledger.test.ts`'s own `claimOrdersInOrder` suite already documented for this exact
  //    shape one level down ("Reproducing it needed a short artificial delay... the plain swap
  //    alone was NOT a reliable RED on its own").
  // This test therefore is NOT a deterministic row-lock regression guard on its own in this
  // environment — an unsorted-loop regression could land here and stay green under ordinary,
  // undelayed CI timing. It is titled accordingly, per the two existing precedents
  // (tests/certs.test.ts:187, tests/ship-ledger.test.ts:290).
  it("two multi-order shipments over {A,B} and {B,A} both complete without deadlocking or a 500 (not a deterministic row-lock regression guard without artificial delay — see comment)", async () => {
    const a = await savedOrder({ qty: 20 });
    // A second order for a's own customer, so a single shipment can legally cover both.
    const bSameCustomer = await (async () => {
      const part = await makePart(a.customer.id);
      await giveSteps(part.id);
      const { order } = await asSystem(() => createOrder({
        customerId: a.customer.id, lines: [{ partId: part.id, qty: 10, weight: "5.00" }],
      }));
      return order;
    })();

    const inputAB = {
      customerId: a.customer.id, shipDate: "2026-08-04",
      orders: [
        { orderId: a.order.id, lines: [{ orderLineId: a.order.lines[0].id, qty: 1, weight: "1.00", lineComplete: false }], containers: [], serials: [] },
        { orderId: bSameCustomer.id, lines: [{ orderLineId: bSameCustomer.lines[0].id, qty: 1, weight: "1.00", lineComplete: false }], containers: [], serials: [] },
      ],
    };
    const inputBA = {
      customerId: a.customer.id, shipDate: "2026-08-04",
      orders: [
        { orderId: bSameCustomer.id, lines: [{ orderLineId: bSameCustomer.lines[0].id, qty: 1, weight: "1.00", lineComplete: false }], containers: [], serials: [] },
        { orderId: a.order.id, lines: [{ orderLineId: a.order.lines[0].id, qty: 1, weight: "1.00", lineComplete: false }], containers: [], serials: [] },
      ],
    };

    const settled = await Promise.allSettled([
      createShipper(inputAB, { canOverrideCreditHold: false }),
      createShipper(inputBA, { canOverrideCreditHold: false }),
    ]);

    for (const result of settled) {
      if (result.status === "rejected") {
        // A legitimate outcome under Serializable is a 409 retry signal, never an unmapped 500
        // and never an indefinite hang (the deadlock this test exists to rule out).
        expect((result.reason as { status?: number }).status).toBe(409);
      }
    }
    expect(settled.some((r) => r.status === "fulfilled")).toBe(true);
  });
});

describe("getShipper", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("returns full detail — label, ordered/shipped-to-date figures, containers and serials", async () => {
    const { order, customer } = await savedOrder({ qty: 10, weight: "25.00" });
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const container = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: containerType.id, count: 2, customerContainerId: "BIN-1" },
    });
    const serial = await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "S-9", description: "Heat 1" },
    });

    const input = oneOrderInput(order);
    input.orders[0].lines[0].qty = 4;
    input.orders[0].lines[0].weight = 10;
    input.orders[0].containers = [{ orderContainerId: container.id, count: 2 }];
    input.orders[0].serials = [{ orderSerialId: serial.id, printOnShipper: true }];
    const { shipper } = await createShipper(input, { canOverrideCreditHold: false });

    const detail = await getShipper(shipper.id);
    expect(detail.customerCode).toBe(customer.code);
    expect(detail.orders).toHaveLength(1);
    const so = detail.orders[0];
    expect(so.label).toBe(`${order.orderNumber}-1`);
    expect(so.lines[0]).toMatchObject({
      orderedQty: 10, orderedWeight: 25, shippedToDateQty: 4, shippedToDateWeight: 10, qty: 4,
    });
    expect(so.containers[0]).toMatchObject({ typeName: "Basket", customerContainerId: "BIN-1", count: 2 });
    expect(so.serials[0]).toMatchObject({ serial: "S-9", description: "Heat 1", printOnShipper: true });
  });

  it("throws 404 for an unknown id", async () => {
    await expect(getShipper("nope")).rejects.toThrow(/not found/i);
  });

  // Task 14 review, Important #1: the add-line picker's ship-now prefill is `ordered − shipped`
  // (design §5.1), and shipped-to-date for a CANDIDATE line — one not on this shipment yet — is
  // knowable nowhere on the page unless the shipment's own GET carries it. `lines[]` only covers
  // what is already on the shipment, so this second, order-wide ledger is what the picker reads.
  it("carries shipped-to-date for EVERY line of each order, not only the lines on this shipment", async () => {
    const { order } = await twoLineOrder();
    const [lineA, lineB] = order.lines;
    // A PRIOR shipment took 4 of line A and 3 of line B.
    await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 4, weight: 10 },
      { orderLineId: lineB.id, qty: 3, weight: 5 },
    ]), { canOverrideCreditHold: false });
    // THIS shipment carries line A only — line B is an add-line candidate on it.
    const { shipper } = await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 2, weight: 5 },
    ]), { canOverrideCreditHold: false });

    const so = (await getShipper(shipper.id)).orders[0];
    expect(so.lines).toHaveLength(1);
    const ledger = new Map(so.orderLineShippedToDate.map((e) => [e.orderLineId, e]));
    expect(ledger.size).toBe(2);
    // Every LIVE shipment counts, this one included (spec §5.1) — 4 + 2 and 10 + 5.
    expect(ledger.get(lineA.id)).toMatchObject({ shippedToDateQty: 6, shippedToDateWeight: 15 });
    // The candidate: shipped only on the OTHER shipment, so its remainder here is 8 − 3 / 12 − 5.
    expect(ledger.get(lineB.id)).toMatchObject({ shippedToDateQty: 3, shippedToDateWeight: 5 });
  });

  it("excludes voided shipments from that per-order-line ledger", async () => {
    const { order } = await twoLineOrder();
    const [lineA, lineB] = order.lines;
    const prior = await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 4, weight: 10 },
      { orderLineId: lineB.id, qty: 3, weight: 5 },
    ]), { canOverrideCreditHold: false });
    const { shipper } = await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 2, weight: 5 },
    ]), { canOverrideCreditHold: false });

    await voidShipper(prior.shipper.id, "loaded onto the wrong truck");

    const so = (await getShipper(shipper.id)).orders[0];
    const ledger = new Map(so.orderLineShippedToDate.map((e) => [e.orderLineId, e]));
    expect(ledger.get(lineA.id)).toMatchObject({ shippedToDateQty: 2, shippedToDateWeight: 5 });
    // A line whose only shipment was voided reports a real 0, not a missing entry — the grid
    // renders the number, and the prefill falls back to the full ordered figure.
    expect(ledger.get(lineB.id)).toMatchObject({ shippedToDateQty: 0, shippedToDateWeight: 0 });
  });
});

// Task 14b: the shipment CREATE page (`/shipping/new`) prefills every grid to the remainder
// (`ordered − shipped`, design §5.1) before any shipper exists — so, unlike the edit page (whose
// `orderLineShippedToDate` rides the shipper's own GET, Task 14 review Important #1), the figure
// has to ride the ORDER's own detail: the same GET the create page already makes per selected
// order for its line/container/serial catalog. Same name, same dense shape, same single
// `shippedTotals` derivation — a widened existing payload, not a new route (spec §9 unchanged).
describe("getOrder shipped-to-date (the /shipping/new prefill seam)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("carries a dense per-line ledger on the order's own detail", async () => {
    const { order } = await twoLineOrder();
    const [lineA, lineB] = order.lines;
    await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 4, weight: 10 },
    ]), { canOverrideCreditHold: false });

    const detail = await getOrder(order.id);
    const ledger = new Map(detail.orderLineShippedToDate.map((e) => [e.orderLineId, e]));
    expect(ledger.size).toBe(2);
    expect(ledger.get(lineA.id)).toMatchObject({ shippedToDateQty: 4, shippedToDateWeight: 10 });
    // DENSE: a never-shipped line reports a real 0/0, so the prefill is the full ordered figure
    // rather than an undefined the grid would have to special-case.
    expect(ledger.get(lineB.id)).toMatchObject({ shippedToDateQty: 0, shippedToDateWeight: 0 });
  });

  it("sums every live shipment and excludes voided ones (spec §5.1)", async () => {
    const { order } = await twoLineOrder();
    const [lineA] = order.lines;
    const prior = await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 4, weight: 10 },
    ]), { canOverrideCreditHold: false });
    await createShipper(shipmentOf(order, [
      { orderLineId: lineA.id, qty: 2, weight: 5 },
    ]), { canOverrideCreditHold: false });

    let ledger = new Map((await getOrder(order.id)).orderLineShippedToDate.map((e) => [e.orderLineId, e]));
    expect(ledger.get(lineA.id)).toMatchObject({ shippedToDateQty: 6, shippedToDateWeight: 15 });

    await voidShipper(prior.shipper.id, "loaded onto the wrong truck");
    ledger = new Map((await getOrder(order.id)).orderLineShippedToDate.map((e) => [e.orderLineId, e]));
    expect(ledger.get(lineA.id)).toMatchObject({ shippedToDateQty: 2, shippedToDateWeight: 5 });
  });
});
