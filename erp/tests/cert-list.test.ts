// The certifications worklist page (src/app/certs/CertList.tsx) is a thin fetch-and-render shell
// around `listCerts`/`exportCerts` (src/server/certs.ts) — those functions and their per-filter
// behavior already carry thorough coverage in tests/certs.test.ts (Task 5). This file does NOT
// re-derive that coverage field by field; it pins the exact contract the WORKLIST PAGE depends on
// instead: filters combined the way the filter bar actually sends them (not one at a time), the
// `sequence` field the page turns into the `#72036-3` order label, and — the one genuine gap
// nothing else in the suite exercises — `failCount` with actual failing readings, across more
// than one requirement on a cert. The page itself has no vitest coverage of its own; it is
// exercised visually here (this task) and end-to-end by Task 20.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { addPartInspection } from "@/server/part-inspections";
import { createCert, listCerts, voidCert, type CertRow } from "@/server/certs";
import { replaceReadings } from "@/server/cert-results";
import type { Customer, Part } from "../prisma/generated/prisma/client";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({ data: { code: `CL${customerSeq}`, name: `Cert List Customer ${customerSeq}` } });
}

let partSeq = 0;
async function makePart(customerId: string): Promise<Part> {
  partSeq += 1;
  return prisma.part.create({ data: { customerId, partNumber: `CLP-${partSeq}`, eachWeight: "1.0000" } });
}

/** Gives a part revision 1 with one step — the orderability precondition createOrder enforces
 *  (spec §5.3), the certs.test.ts precedent. */
async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `HT-CL-${partId}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
}

/** A live, orderable customer + part, and the ORDER created from it. */
async function savedOrder(
  opts: { poNumber?: string } = {},
): Promise<{ order: OrderDetail; part: Part; customer: Customer }> {
  const customer = await makeCustomer();
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: opts.poNumber ?? "",
    lines: [{ partId: part.id, qty: 10, weight: "25.00" }],
  }));
  return { order, part, customer };
}

let shipperSeq = 9000;
/** A minimal, live Shipper + ShipperOrder pairing — raw prisma, the certs.test.ts precedent
 *  (shippers.ts is a different lane's file, not depended on here). */
async function makeShipment(customerId: string, orderId: string, sequence: number): Promise<{ id: string }> {
  shipperSeq += 1;
  const shipper = await prisma.shipper.create({
    data: { shipperNumber: shipperSeq, customerId, shipDate: new Date() },
  });
  await prisma.shipperOrder.create({ data: { shipperId: shipper.id, orderId, sequence, position: sequence } });
  return shipper;
}

function byId(rows: CertRow[]): Map<string, CertRow> {
  return new Map(rows.map((r) => [r.id, r]));
}

describe("listCerts — the certifications worklist's own filter and column contract", () => {
  beforeEach(truncateAll);

  it("narrows by customer, scope, printed and search — combined in one query, the way the filter bar sends them", async () => {
    const a = await savedOrder({ poNumber: "CL-PO-1" });
    const b = await savedOrder({ poNumber: "CL-PO-2" });
    const orderCertA = await createCert({ orderId: a.order.id, scope: "ORDER" });
    const loadCertA = await createCert({ orderId: a.order.id, scope: "LOAD", loadNumber: 1 });
    const orderCertB = await createCert({ orderId: b.order.id, scope: "ORDER" });
    await prisma.cert.update({ where: { id: orderCertA.id }, data: { printedAt: new Date() } });

    expect((await listCerts({ customerId: a.customer.id })).map((c) => c.id).sort())
      .toEqual([orderCertA.id, loadCertA.id].sort());
    expect((await listCerts({ scope: "LOAD" })).map((c) => c.id)).toEqual([loadCertA.id]);
    expect((await listCerts({ printed: true })).map((c) => c.id)).toEqual([orderCertA.id]);

    // Customer + scope + printed together narrow to exactly the one row satisfying all three —
    // never tested combined elsewhere, only one filter key per call.
    expect((await listCerts({ customerId: a.customer.id, scope: "ORDER", printed: true })).map((c) => c.id))
      .toEqual([orderCertA.id]);
    expect((await listCerts({ customerId: a.customer.id, scope: "ORDER", printed: false })).map((c) => c.id))
      .toEqual([]);

    // Search over the order number reaches every cert on that order; search over a customer's
    // code reaches only that customer's certs.
    expect((await listCerts({ search: String(a.order.orderNumber) })).map((c) => c.id).sort())
      .toEqual([orderCertA.id, loadCertA.id].sort());
    expect((await listCerts({ search: b.customer.code })).map((c) => c.id)).toEqual([orderCertB.id]);
  });

  it("excludes voided certs when includeVoided is left off the filter (the unchecked-box shape), and restores them when set", async () => {
    const { order } = await savedOrder();
    const live = await createCert({ orderId: order.id, scope: "ORDER" });
    const voided = await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 9 });
    await asSystem(() => voidCert(voided.id, "test"));

    expect((await listCerts({ customerId: order.customerId })).map((c) => c.id)).toEqual([live.id]);
    expect((await listCerts({ customerId: order.customerId, includeVoided: true })).map((c) => c.id).sort())
      .toEqual([live.id, voided.id].sort());
  });

  it("populates `sequence` for a SHIPMENT-scope row — the `#72036-3` order label the worklist renders — and leaves it null for ORDER/LOAD scope", async () => {
    const { order, customer } = await savedOrder();
    const shipper = await makeShipment(customer.id, order.id, 3);
    const shipmentCert = await createCert({ orderId: order.id, scope: "SHIPMENT", shipperId: shipper.id });
    const orderCert = await createCert({ orderId: order.id, scope: "ORDER" });

    const rows = byId(await listCerts({ customerId: customer.id }));
    expect(rows.get(shipmentCert.id)?.sequence).toBe(3);
    expect(rows.get(orderCert.id)?.sequence).toBeNull();
  });

  it("failCount counts only readings whose passed is exactly false, summed across every requirement on the cert", async () => {
    const customer = await makeCustomer();
    const leadPart = await makePart(customer.id);
    const riderPart = await makePart(customer.id);
    await giveSteps(leadPart.id);
    const code = await prisma.inspectionCode.create({ data: { name: "CL-Hardness" } });
    await asSystem(() => addPartInspection(leadPart.id, { inspectionCodeId: code.id, sort: 0, min: 28, max: 32 }));
    await asSystem(() => addPartInspection(riderPart.id, { inspectionCodeId: code.id, sort: 0, min: 28, max: 32 }));
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "",
      lines: [
        { partId: leadPart.id, qty: 10, weight: "25.00" },
        { partId: riderPart.id, qty: 5, weight: "10.00" },
      ],
    }));
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    expect(cert.requirements).toHaveLength(2);

    // Requirement 1: one pass (30.0, within 28-32), one fail (20.0, below min).
    // Requirement 2: one fail (26.0, below min). A reading left with no value at all (`passed`
    // stays null) counts toward neither readingCount's complement nor failCount.
    await asSystem(() => replaceReadings(cert.id, {
      requirements: [
        { id: cert.requirements[0].id, readings: [{ value: "30.0" }, { value: "20.0" }] },
        { id: cert.requirements[1].id, readings: [{ value: "26.0" }] },
      ],
    }, { afterPrint: false }));

    const [row] = await listCerts({ customerId: customer.id });
    expect(row.readingCount).toBe(3);
    expect(row.failCount).toBe(2);
  });
});
