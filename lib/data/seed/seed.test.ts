import { describe, it, expect } from "vitest";
import { buildSeed } from "@/lib/data/seed";
import {
  operatorSchema,
  specificationSchema,
  priceKeySchema,
  pricingRuleSchema,
  customerSchema,
  contactSchema,
  processMasterSchema,
  partSchema,
  quoteSchema,
  workOrderSchema,
  certificationSchema,
  invoiceSchema,
  scheduleBlockSchema,
} from "@/lib/domain";
import { EQUIPMENT } from "@/lib/domain/enums";

describe("seed", () => {
  const s = buildSeed();

  it("validates every array against its schema", () => {
    s.operators.forEach((r) => expect(() => operatorSchema.parse(r)).not.toThrow());
    s.specifications.forEach((r) => expect(() => specificationSchema.parse(r)).not.toThrow());
    s.priceKeys.forEach((r) => expect(() => priceKeySchema.parse(r)).not.toThrow());
    s.pricingRules.forEach((r) => expect(() => pricingRuleSchema.parse(r)).not.toThrow());
    s.customers.forEach((r) => expect(() => customerSchema.parse(r)).not.toThrow());
    s.contacts.forEach((r) => expect(() => contactSchema.parse(r)).not.toThrow());
    s.processMasters.forEach((r) => expect(() => processMasterSchema.parse(r)).not.toThrow());
    s.parts.forEach((r) => expect(() => partSchema.parse(r)).not.toThrow());
    s.quotes.forEach((r) => expect(() => quoteSchema.parse(r)).not.toThrow());
    s.workOrders.forEach((r) => expect(() => workOrderSchema.parse(r)).not.toThrow());
    s.certifications.forEach((r) => expect(() => certificationSchema.parse(r)).not.toThrow());
    s.invoices.forEach((r) => expect(() => invoiceSchema.parse(r)).not.toThrow());
    s.scheduleBlocks.forEach((r) => expect(() => scheduleBlockSchema.parse(r)).not.toThrow());
  });

  it("has the Apex multi-part order", () => {
    expect(s.workOrders.find((w) => w.number === "WO-48211")?.lines.length).toBe(2);
  });

  it("resolves every quote and work-order customerId to a seeded customer", () => {
    const customerIds = new Set(s.customers.map((c) => c.id));
    s.quotes.forEach((q) => expect(customerIds.has(q.customerId)).toBe(true));
    s.workOrders.forEach((w) => expect(customerIds.has(w.customerId)).toBe(true));
  });

  it("populates live traveler steps on every work order", () => {
    s.workOrders.forEach((w) => {
      expect(w.steps.length).toBeGreaterThan(0);
      w.steps.forEach((st) => {
        expect(["pending", "in_process", "done"]).toContain(st.state);
        expect(st.areaId).toBeTruthy();
      });
    });
  });
  it("has a credit-hold order that is ready to ship (Vulcan)", () => {
    const held = s.workOrders.find((w) => w.customerId === "cust-vulcan" && w.status === "ready_to_ship");
    expect(held).toBeTruthy();
    expect(held!.steps.every((st) => st.state === "done")).toBe(true);
    const heldCustomer = s.customers.find((c) => c.id === held!.customerId);
    expect(heldCustomer!.status).toBe("hold");
  });

  it("resolves cross-entity foreign keys within the seed", () => {
    const has = <T extends { id: string }>(arr: T[], id: string) => arr.some((r) => r.id === id);
    const nullOr = <T extends { id: string }>(arr: T[], id: string | null) => id === null || has(arr, id);

    // customers -> priceKey / defaultCertSpec
    s.customers.forEach((c) => {
      expect(nullOr(s.priceKeys, c.priceKeyId)).toBe(true);
      expect(nullOr(s.specifications, c.defaultCertSpecId)).toBe(true);
    });
    // contacts -> customer
    s.contacts.forEach((ct) => expect(has(s.customers, ct.customerId)).toBe(true));
    // pricingRules -> priceKey
    s.pricingRules.forEach((pr) => expect(has(s.priceKeys, pr.priceKeyId)).toBe(true));
    // parts -> customer / spec / processMaster / priceKey
    s.parts.forEach((p) => {
      expect(has(s.customers, p.customerId)).toBe(true);
      expect(nullOr(s.specifications, p.specificationId)).toBe(true);
      expect(nullOr(s.processMasters, p.processMasterId)).toBe(true);
      expect(nullOr(s.priceKeys, p.priceKeyId)).toBe(true);
    });
    // quotes -> customer / salesperson / part / wonOrder
    s.quotes.forEach((q) => {
      expect(has(s.customers, q.customerId)).toBe(true);
      expect(has(s.operators, q.salespersonId)).toBe(true);
      expect(nullOr(s.workOrders, q.wonOrderId)).toBe(true);
      q.parts.forEach((qp) => expect(has(s.parts, qp.partId)).toBe(true));
    });
    // work orders -> customer / quote / processMaster / certSpec / part
    s.workOrders.forEach((w) => {
      expect(has(s.customers, w.customerId)).toBe(true);
      expect(nullOr(s.quotes, w.quoteId)).toBe(true);
      expect(nullOr(s.processMasters, w.processMasterId)).toBe(true);
      expect(nullOr(s.specifications, w.certSpecId)).toBe(true);
      w.lines.forEach((l) => expect(has(s.parts, l.partId)).toBe(true));
    });
    // certifications -> customer / workOrder / spec
    s.certifications.forEach((c) => {
      expect(has(s.customers, c.customerId)).toBe(true);
      expect(has(s.workOrders, c.workOrderId)).toBe(true);
      expect(nullOr(s.specifications, c.specificationId)).toBe(true);
    });
    // invoices -> customer / workOrder
    s.invoices.forEach((inv) => {
      expect(has(s.customers, inv.customerId)).toBe(true);
      expect(has(s.workOrders, inv.workOrderId)).toBe(true);
    });
    // scheduleBlocks -> workOrder / equipment roster
    s.scheduleBlocks.forEach((b) => {
      expect(has(s.workOrders, b.workOrderId)).toBe(true);
      expect(EQUIPMENT.some((e) => e.id === b.equipmentId)).toBe(true);
    });
  });
});
