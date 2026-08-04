import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { setSetting } from "@/server/settings";
import { resolveCertSettings } from "@/server/certs";
import { createOrder, getOrder } from "@/server/orders";
import type { Customer, Part } from "../prisma/generated/prisma/client";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(opts: {
  certRequiredDefault?: boolean | null; certScopeDefault?: "ORDER" | "LOAD" | "SHIPMENT" | null;
} = {}): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: {
      code: `C${customerSeq}`, name: `Customer ${customerSeq}`,
      certRequiredDefault: opts.certRequiredDefault ?? null,
      certScopeDefault: opts.certScopeDefault ?? null,
    },
  });
}

let partSeq = 0;
async function makePart(customerId: string, opts: {
  certRequired?: boolean | null; certScope?: "ORDER" | "LOAD" | "SHIPMENT" | null;
} = {}): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({
    data: {
      customerId, partNumber: `P-${partSeq}`, eachWeight: "1.0000",
      certRequired: opts.certRequired ?? null,
      certScope: opts.certScope ?? null,
    },
  });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the same shape orders.test.ts's own `giveSteps` builds with raw prisma. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

/** A live, orderable customer + part, and the ORDER created from it — the fixture the
 *  freeze-at-save test needs: a real saved order whose `certRequired`/`certScope` came off the
 *  part's resolution at the moment of the save. */
async function savedOrder(opts: {
  partCertRequired?: boolean | null; partCertScope?: "ORDER" | "LOAD" | "SHIPMENT" | null;
} = {}): Promise<{ order: { id: string }; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  const part = await makePart(customer.id, {
    certRequired: opts.partCertRequired, certScope: opts.partCertScope,
  });
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    lines: [{ partId: part.id, qty: 10, weight: "25.00" }],
  }));
  return { order, part, customer };
}

describe("resolveCertSettings", () => {
  beforeEach(truncateAll);

  it("lets the part beat the customer beat the plant", async () => {
    await setSetting("cert_required_default", false);
    const c = await makeCustomer({ certRequiredDefault: true });
    const p = await makePart(c.id, { certRequired: false });
    expect((await resolveCertSettings(prisma, c.id, [p.id])).certRequired).toBe(false);
  });

  it("requires a cert when ANY line requires one", async () => {
    await setSetting("cert_required_default", false);
    const c = await makeCustomer({ certRequiredDefault: null });
    const lead = await makePart(c.id, { certRequired: false });
    const rider = await makePart(c.id, { certRequired: true });
    expect((await resolveCertSettings(prisma, c.id, [lead.id, rider.id])).certRequired).toBe(true);
  });

  it("takes scope from the lead line when lines disagree", async () => {
    const c = await makeCustomer({ certScopeDefault: "ORDER" });
    const lead = await makePart(c.id, { certScope: "LOAD" });
    const rider = await makePart(c.id, { certScope: "SHIPMENT" });
    expect((await resolveCertSettings(prisma, c.id, [lead.id, rider.id])).certScope).toBe("LOAD");
  });

  it("freezes the resolution onto the order at save", async () => {
    const { order, part, customer } = await savedOrder({ partCertRequired: true, partCertScope: "SHIPMENT" });
    await prisma.part.update({ where: { id: part.id }, data: { certRequired: false, certScope: "ORDER" } });
    const after = await getOrder(order.id);
    expect(after.certRequired).toBe(true);
    expect(after.certScope).toBe("SHIPMENT");
    // Untouched — no cross-contamination between this test's fixture and the assertion above.
    expect(customer.certRequiredDefault).toBeNull();
  });

  it("falls all the way through to the plant default when nothing overrides it", async () => {
    await setSetting("cert_required_default", true);
    await setSetting("cert_scope_default", "LOAD");
    const c = await makeCustomer();
    const p = await makePart(c.id);
    const resolved = await resolveCertSettings(prisma, c.id, [p.id]);
    expect(resolved.certRequired).toBe(true);
    expect(resolved.certScope).toBe("LOAD");
  });

  it("an explicit false on the part beats a true customer default (false and null stay distinct)", async () => {
    const c = await makeCustomer({ certRequiredDefault: true });
    const p = await makePart(c.id, { certRequired: false });
    expect((await resolveCertSettings(prisma, c.id, [p.id])).certRequired).toBe(false);
  });
});
