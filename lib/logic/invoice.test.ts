import { describe, it, expect } from "vitest";
import { toBillInvoiceFromOrder, billInvoice, payInvoice } from "@/lib/logic/invoice";
import type { WorkOrder, Invoice } from "@/lib/domain";

const order = { id:"wo1", customerId:"c1", orderValueCents: 842000 } as WorkOrder;

describe("invoice lifecycle", () => {
  it("creates a to_bill invoice on ship with no number", () => {
    const inv = toBillInvoiceFromOrder(order, "2026-07-02T00:00:00.000Z");
    expect(inv.status).toBe("to_bill");
    expect(inv.number).toBeNull();
    expect(inv.amountCents).toBe(842000);
  });
  it("bills -> sent with a number + date", () => {
    const inv = billInvoice({ status:"to_bill", number:null, invoicedDate:null } as Invoice, "INV-30412", "2026-07-03T00:00:00.000Z");
    expect(inv.status).toBe("sent");
    expect(inv.number).toBe("INV-30412");
  });
  it("pays -> paid", () => {
    expect(payInvoice({ status:"sent" } as Invoice, "2026-07-20T00:00:00.000Z").status).toBe("paid");
  });
});
