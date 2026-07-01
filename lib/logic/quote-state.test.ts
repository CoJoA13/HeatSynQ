import { describe, it, expect } from "vitest";
import { requiresApproval, sendQuote, approveQuote, rejectQuote, winQuote, reviseQuote, isEditable } from "@/lib/logic/quote-state";
import type { Quote, Operator } from "@/lib/domain";

const op = (limit: number): Operator => ({ id:"o1", createdAt:"", updatedAt:"", version:0,
  name:"Dana", initials:"DM", title:"PM", role:"sales", quoteAuthLimitCents: limit });

const draft = (totalLine: number): Quote => ({ id:"q1", createdAt:"", updatedAt:"", version:0,
  number:"Q-2841", rev:0, customerId:"c1", customerPO:"", status:"draft", salespersonId:"o1",
  date:"", validUntil:"", requiredBy:null, discount:null, estCostCents:0, notes:"", wonOrderId:null,
  parts:[{ id:"p", partId:"x", material:"4140", quantity:1, lines:[
    { id:"l", process:"Carburize", basis:"flat", qtyOrWeight:1, rateCents: totalLine, minChargeCents:null }]}] });

describe("quote lifecycle", () => {
  it("only drafts are editable", () => {
    expect(isEditable(draft(1))).toBe(true);
    expect(isEditable({ ...draft(1), status:"sent" })).toBe(false);
  });
  it("under limit sends directly", () => {
    expect(requiresApproval(draft(2000000), op(2500000))).toBe(false);
    expect(sendQuote(draft(2000000), op(2500000)).status).toBe("sent");
  });
  it("over limit routes to approval", () => {
    expect(requiresApproval(draft(3000000), op(2500000))).toBe(true);
    expect(sendQuote(draft(3000000), op(2500000)).status).toBe("approve");
  });
  it("approve -> sent, reject -> draft", () => {
    expect(approveQuote({ ...draft(1), status:"approve" }).status).toBe("sent");
    expect(rejectQuote({ ...draft(1), status:"approve" }).status).toBe("draft");
  });
  it("win sets won", () => {
    expect(winQuote({ ...draft(1), status:"sent" }).status).toBe("won");
  });
  it("revise clones as a new draft revision", () => {
    const r = reviseQuote({ ...draft(1), status:"sent", rev:0 });
    expect(r.status).toBe("draft");
    expect(r.rev).toBe(1);
  });
});
