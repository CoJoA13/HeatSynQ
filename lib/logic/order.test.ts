import { describe, it, expect } from "vitest";
import { createOrderFromQuote, canShipOrder, canTransitionOrder, createCertForOrder, activityEntry } from "@/lib/logic/order";
import type { Quote, Part, ProcessMaster, Customer, WorkOrder, Certification } from "@/lib/domain";

const part: Part = { id:"pt1", createdAt:"", updatedAt:"", version:0, partNumber:"TS-4471",
  description:"Turbine shaft", customerId:"c1", material:"4140 steel", drawingRev:"C",
  hardness:"Rc 58-62", caseDepth:".020-.030 in", specificationId:"s1", processMasterId:"pm1",
  priceKeyId:"pk1", inspectionScale:"Rockwell C", inspectionSample:"3 pc / lot" };

const pm: ProcessMaster = { id:"pm1", createdAt:"", updatedAt:"", version:0, code:"PM-CARB-58",
  name:"Carburize & temper", description:"", rev:"C", status:"active", surfaceHardness:"Rc 58-62",
  caseDepth:".020-.030 in", hardnessScale:"Rockwell C", steps:[
    { n:1, op:"Receive & verify", equip:"Receiving", instr:"", params:[], track:"track_in" }] };

const customer: Customer = { id:"c1", createdAt:"", updatedAt:"", version:0, customerNumber:"1042",
  name:"Apex Aerospace", initials:"AA", city:"", billingAddress:"", phone:"", terms:"Net 30",
  status:"active", priceKeyId:"pk1", taxExempt:true, defaultCertSpecId:"s1", defaultCertCopies:2, ytdSalesCents:0 };

const quote: Quote = { id:"q1", createdAt:"", updatedAt:"", version:0, number:"Q-2841", rev:0,
  customerId:"c1", customerPO:"7741-A", status:"won", salespersonId:"o1", date:"", validUntil:"",
  requiredBy:null, discount:null, estCostCents:0, notes:"", wonOrderId:null, parts:[
  { id:"qp1", partId:"pt1", material:"4140 steel", quantity:480, lines:[
    { id:"l1", process:"Carburize", basis:"per_lb", qtyOrWeight:600, rateCents:1030, minChargeCents:null },
    { id:"l2", process:"Temper", basis:"per_lot", qtyOrWeight:1, rateCents:144000, minChargeCents:null }]}] };

describe("order creation", () => {
  const order = createOrderFromQuote(quote, { partsById:{ pt1: part }, processMastersById:{ pm1: pm }, customer });
  it("carries the quote total into orderValue", () => {
    expect(order.orderValueCents).toBe(618000 + 144000);
  });
  it("links the quote and copies customer PO", () => {
    expect(order.quoteId).toBe("q1");
    expect(order.customerPO).toBe("7741-A");
  });
  it("instantiates traveler steps from the part's process master", () => {
    expect(order.steps[0].op).toBe("Receive & verify");
  });
  it("sets cert flag from the customer default cert spec", () => {
    expect(order.certifyRequired).toBe(true);
    expect(order.certSpecId).toBe("s1");
  });
  it("starts at received with an activity entry", () => {
    expect(order.status).toBe("received");
    expect(order.activity[0].message).toContain("Q-2841");
  });
  it("creates one order line per quote part", () => {
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].quantity).toBe(480);
  });
});

describe("discounted quote pricing", () => {
  const discountedQuote: Quote = {
    ...quote,
    discount: { kind: "percent", value: 10 },
  };
  const order = createOrderFromQuote(discountedQuote, { partsById: { pt1: part }, processMastersById: { pm1: pm }, customer });
  it("appends a Discount pricing line so pricing lines sum to orderValue", () => {
    const sum = order.pricing.reduce((s, p) => s + p.amountCents, 0);
    expect(sum).toBe(order.orderValueCents);
    const discountLine = order.pricing.find((p) => p.process === "Discount");
    expect(discountLine).toBeTruthy();
    expect(discountLine!.amountCents).toBeLessThan(0);
  });
  it("omits the Discount line when the quote has no discount", () => {
    const undiscounted = createOrderFromQuote(quote, { partsById: { pt1: part }, processMastersById: { pm1: pm }, customer });
    expect(undiscounted.pricing.some((p) => p.process === "Discount")).toBe(false);
  });
});

describe("ship gate", () => {
  it("blocks ship when a required cert is not released", () => {
    const o = { certifyRequired:true } as WorkOrder;
    expect(canShipOrder(o, { status:"pending" } as Certification).ok).toBe(false);
  });
  it("allows ship when cert released", () => {
    const o = { certifyRequired:true } as WorkOrder;
    expect(canShipOrder(o, { status:"released" } as Certification).ok).toBe(true);
  });
  it("allows ship when no cert required", () => {
    expect(canShipOrder({ certifyRequired:false } as WorkOrder, null).ok).toBe(true);
  });
});

describe("order transitions", () => {
  it("permits received -> scheduled but not received -> shipped", () => {
    expect(canTransitionOrder("received","scheduled")).toBe(true);
    expect(canTransitionOrder("received","shipped")).toBe(false);
  });
});

describe("createCertForOrder", () => {
  it("builds a pending cert from the order + customer default copies", () => {
    const order = { id: "wo-x", customerId: "cust-apex", processSummary: "Carburize + Temper", certSpecId: "spec-ams2759-3", certifyRequired: true } as unknown as WorkOrder;
    const cust = { defaultCertCopies: 2 } as unknown as Customer;
    const cert = createCertForOrder(order, cust);
    expect(cert).toMatchObject({ customerId: "cust-apex", workOrderId: "wo-x", specificationId: "spec-ams2759-3", status: "pending", copies: 2, type: "Carburize + Temper" });
    expect("number" in cert).toBe(false); // create() assigns C-#
  });
});

describe("activityEntry", () => {
  it("builds an activity entry", () => {
    expect(activityEntry("Dana", "Shipped", "2026-07-01T00:00:00.000Z"))
      .toEqual({ actor: "Dana", message: "Shipped", at: "2026-07-01T00:00:00.000Z" });
  });
});
