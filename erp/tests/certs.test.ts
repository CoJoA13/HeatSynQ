import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { readAudit } from "@/server/audit";
import { createOrder, voidOrder, type OrderDetail } from "@/server/orders";
import { resplitLoads } from "@/server/order-loads";
import {
  createCert, getCert, listCerts, exportCerts, updateCert, voidCert, certsForOrder,
} from "@/server/certs";
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
  beforeEach(truncateAll);

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

  it("scopes by load and by shipment independently", async () => {
    const { order } = await savedOrder();
    await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 1 });
    await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 2 });
    await expect(createCert({ orderId: order.id, scope: "LOAD", loadNumber: 1 }))
      .rejects.toThrow(/already has a certification/i);
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
    const { order } = await savedOrder();
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "LOAD", loadNumber: 2 }));
    const [entry] = await readAudit("cert", cert.id);
    expect(entry.action).toBe("create");
    expect(entry.after).toMatchObject({ orderId: order.id, scope: "LOAD", loadNumber: 2, shipperId: null });
  });
});

describe("createCert at order save", () => {
  beforeEach(truncateAll);

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
  beforeEach(truncateAll);

  // Task 6's `replaceResults` does not exist yet (this task runs before it), so this asserts what
  // is provable today: the cert survives a re-split with its loadNumber unchanged. Task 6 extends
  // it with a readings-survive assertion once `replaceResults` (cert-results.ts) exists.
  it("leaves the cert live with its loadNumber unchanged after a re-split", async () => {
    const { order } = await savedOrder({ loadQty: 300, qty: 1000 }); // 4 loads
    const cert = await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 3 });

    await asSystem(() => resplitLoads(order.id));

    const after = await getCert(cert.id);
    expect(after.deletedAt).toBeNull();
    expect(after.loadNumber).toBe(3);
  });
});

describe("getCert", () => {
  beforeEach(truncateAll);

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
  beforeEach(truncateAll);

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
});

describe("voidCert", () => {
  beforeEach(truncateAll);

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
  beforeEach(truncateAll);

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
  beforeEach(truncateAll);

  async function sheetOf(buf: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    return wb.getWorksheet("Certifications")!;
  }

  it("writes the cert columns with a header row and one row per cert", async () => {
    const { order } = await savedOrder();
    await createCert({ orderId: order.id, scope: "LOAD", loadNumber: 4 });

    const sheet = await sheetOf(await exportCerts({}));
    expect(sheet.getRow(1).values).toEqual([undefined,
      "Order #", "Seq", "Customer code", "Customer name", "Scope", "Load #", "Shipper #",
      "Printed", "Readings", "Fails", "Voided"]);
    const cells = (n: number) => sheet.getRow(2).getCell(n).value;
    expect(cells(1)).toBe(order.orderNumber);
    expect(cells(5)).toBe("LOAD");
    expect(cells(6)).toBe(4);
    expect(cells(8)).toBe("no");
    expect(cells(9)).toBe(0);
    expect(cells(10)).toBe(0);
    expect(cells(11)).toBe("no");
    expect(sheet.rowCount).toBe(2);
  });
});

describe("certsForOrder", () => {
  beforeEach(truncateAll);

  it("returns every cert for the order, voided included", async () => {
    const { order } = await savedOrder();
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
