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
  const order = createOrderFromQuote(quote, { partsById:{ pt1: part }, processMastersById:{ pm1: pm }, customer, nowIso: "2026-07-01T00:00:00.000Z" });
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
  it("initializes every step to pending with an area and null stamps", () => {
    expect(order.steps[0].state).toBe("pending");
    expect(order.steps[0].areaId).toBe("received"); // "Receive & verify"
    expect(order.steps[0].trackedInAt).toBeNull();
    expect(order.steps[0].operatorId).toBeNull();
    expect(order.steps[0].operatorInitials).toBeNull();
    expect(order.steps[0].trackedOutAt).toBeNull();
    expect(order.steps[0].inspectResult).toBeNull();
  });
  it("sets cert flag from the customer default cert spec", () => {
    expect(order.certifyRequired).toBe(true);
    expect(order.certSpecId).toBe("s1");
  });
  it("falls back to a quoted part's spec when the customer has no default cert spec", () => {
    const noDefaultCustomer: Customer = { ...customer, defaultCertSpecId: null };
    // part has specificationId "s1"
    const o = createOrderFromQuote(quote, { partsById: { pt1: part }, processMastersById: { pm1: pm }, customer: noDefaultCustomer, nowIso: "2026-07-01T00:00:00.000Z" });
    expect(o.certifyRequired).toBe(true);
    expect(o.certSpecId).toBe("s1");
  });
  it("requires no cert when neither the customer nor any part carries a spec", () => {
    const noDefaultCustomer: Customer = { ...customer, defaultCertSpecId: null };
    const partNoSpec: Part = { ...part, specificationId: null };
    const o = createOrderFromQuote(quote, { partsById: { pt1: partNoSpec }, processMastersById: { pm1: pm }, customer: noDefaultCustomer, nowIso: "2026-07-01T00:00:00.000Z" });
    expect(o.certifyRequired).toBe(false);
    expect(o.certSpecId).toBe(null);
  });
  it("requires cert from an explicit Certification line even with no customer or part spec", () => {
    const noDefaultCustomer: Customer = { ...customer, defaultCertSpecId: null };
    const partNoSpec: Part = { ...part, specificationId: null };
    const certLineQuote: Quote = { ...quote, parts: [
      { id: "qp1", partId: "pt1", material: "4140 steel", quantity: 480, lines: [
        { id: "l1", process: "Carburize", basis: "per_lb", qtyOrWeight: 600, rateCents: 1030, minChargeCents: null },
        { id: "lc", process: "Certification", basis: "flat", qtyOrWeight: 1, rateCents: 80000, minChargeCents: null }] }] };
    const o = createOrderFromQuote(certLineQuote, { partsById: { pt1: partNoSpec }, processMastersById: { pm1: pm }, customer: noDefaultCustomer, nowIso: "2026-07-01T00:00:00.000Z" });
    expect(o.certifyRequired).toBe(true);
    expect(o.certSpecId).toBe(null); // null spec is allowed by the Certification schema
  });
  it("starts at received with an activity entry", () => {
    expect(order.status).toBe("received");
    expect(order.activity[0].message).toContain("Q-2841");
  });
  it("creates one order line per quote part", () => {
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].quantity).toBe(480);
  });
  it("uses nowIso as due when requiredBy is null (no stale quote date)", () => {
    const nowIso = "2026-07-01T12:00:00.000Z";
    const undatedQuote: Quote = { ...quote, requiredBy: null, date: "2025-01-10T00:00:00.000Z" };
    const o = createOrderFromQuote(undatedQuote, { partsById: { pt1: part }, processMastersById: { pm1: pm }, customer, nowIso });
    expect(o.due).toBe(nowIso);
  });
});

describe("discounted quote pricing", () => {
  const discountedQuote: Quote = {
    ...quote,
    discount: { kind: "percent", value: 10 },
  };
  const order = createOrderFromQuote(discountedQuote, { partsById: { pt1: part }, processMastersById: { pm1: pm }, customer, nowIso: "2026-07-01T00:00:00.000Z" });
  it("appends a Discount pricing line so pricing lines sum to orderValue", () => {
    const sum = order.pricing.reduce((s, p) => s + p.amountCents, 0);
    expect(sum).toBe(order.orderValueCents);
    const discountLine = order.pricing.find((p) => p.process === "Discount");
    expect(discountLine).toBeTruthy();
    expect(discountLine!.amountCents).toBeLessThan(0);
  });
  it("omits the Discount line when the quote has no discount", () => {
    const undiscounted = createOrderFromQuote(quote, { partsById: { pt1: part }, processMastersById: { pm1: pm }, customer, nowIso: "2026-07-01T00:00:00.000Z" });
    expect(undiscounted.pricing.some((p) => p.process === "Discount")).toBe(false);
  });
});

describe("multi-part traveler carry", () => {
  const pmA: ProcessMaster = { ...pm, id: "pmA", code: "PM-A", steps: [
    { n: 1, op: "Op A1", equip: "Furnace A", instr: "", params: [], track: "track_in" },
    { n: 2, op: "Op A2", equip: "Furnace A", instr: "", params: [], track: "track_out" }] };
  const pmB: ProcessMaster = { ...pm, id: "pmB", code: "PM-B", steps: [
    { n: 1, op: "Op B1", equip: "Furnace B", instr: "", params: [], track: "track_in" }] };
  const partA: Part = { ...part, id: "ptA", processMasterId: "pmA", specificationId: null };
  const partB: Part = { ...part, id: "ptB", processMasterId: "pmB", specificationId: null };
  const twoPartQuote: Quote = { ...quote, parts: [
    { id: "qpA", partId: "ptA", material: "4140 steel", quantity: 100, lines: [
      { id: "la", process: "Anneal", basis: "per_lb", qtyOrWeight: 100, rateCents: 100, minChargeCents: null }] },
    { id: "qpB", partId: "ptB", material: "4140 steel", quantity: 200, lines: [
      { id: "lb", process: "Harden", basis: "per_lb", qtyOrWeight: 200, rateCents: 100, minChargeCents: null }] },
  ] };
  const order = createOrderFromQuote(twoPartQuote, {
    partsById: { ptA: partA, ptB: partB }, processMastersById: { pmA, pmB },
    customer: { ...customer, defaultCertSpecId: null }, nowIso: "2026-07-01T00:00:00.000Z",
  });
  it("carries operations from BOTH process masters", () => {
    const ops = order.steps.map((s) => s.op);
    expect(ops).toEqual(["Op A1", "Op A2", "Op B1"]);
  });
  it("renumbers steps 1..N with no gaps or dupes", () => {
    expect(order.steps.map((s) => s.n)).toEqual([1, 2, 3]);
  });
  it("keeps processMasterId as the first part's PM (recipe header ref)", () => {
    expect(order.processMasterId).toBe("pmA");
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
  it("blocks ship when the customer is on credit hold", () => {
    const o = { certifyRequired: false } as WorkOrder;
    const held = { status: "hold" } as Customer;
    const gate = canShipOrder(o, null, held);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/credit hold/i);
  });
  it("allows ship for an active customer with no cert required", () => {
    const o = { certifyRequired: false } as WorkOrder;
    expect(canShipOrder(o, null, { status: "active" } as Customer).ok).toBe(true);
  });
});

describe("order transitions", () => {
  it("permits received -> scheduled but not received -> shipped", () => {
    expect(canTransitionOrder("received","scheduled")).toBe(true);
    expect(canTransitionOrder("received","shipped")).toBe(false);
  });
  it("permits on_hold -> ready_to_ship (resume when all steps done)", () => {
    expect(canTransitionOrder("on_hold", "ready_to_ship")).toBe(true);
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

describe("zero-trackable-step order", () => {
  it("produces status=ready_to_ship and progressPct=100 when the part has no process master", () => {
    const nopmPart: Part = { ...part, processMasterId: null };
    const o = createOrderFromQuote(quote, { partsById: { pt1: nopmPart }, processMastersById: { pm1: pm }, customer, nowIso: "2026-07-01T00:00:00.000Z" });
    expect(o.steps).toHaveLength(0);
    expect(o.status).toBe("ready_to_ship");
    expect(o.progressPct).toBe(100);
  });
  it("keeps status=received and progressPct=0 for an order with trackable steps", () => {
    const o = createOrderFromQuote(quote, { partsById: { pt1: part }, processMastersById: { pm1: pm }, customer, nowIso: "2026-07-01T00:00:00.000Z" });
    expect(o.steps.length).toBeGreaterThan(0);
    expect(o.status).toBe("received");
    expect(o.progressPct).toBe(0);
  });
});
