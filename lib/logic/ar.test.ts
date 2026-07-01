import { describe, it, expect } from "vitest";
import { agingBucket, ageInvoices, customerBalanceCents } from "@/lib/logic/ar";
import type { Invoice } from "@/lib/domain";

const inv = (id: string, customerId: string, amountCents: number, status: Invoice["status"], invoicedDate: string | null): Invoice =>
  ({ id, createdAt:"", updatedAt:"", version:0, number:"INV-"+id, customerId, workOrderId:"w",
    amountCents, status, shippedDate:"", invoicedDate, paidDate:null });

const asOf = "2026-07-31T00:00:00.000Z";

describe("AR aging", () => {
  it("buckets by age of invoice date", () => {
    expect(agingBucket(inv("1","c1",100,"sent","2026-07-25T00:00:00.000Z"), asOf)).toBe("current");
    expect(agingBucket(inv("2","c1",100,"sent","2026-07-10T00:00:00.000Z"), asOf)).toBe("d1_30");
    expect(agingBucket(inv("3","c1",100,"sent","2026-06-15T00:00:00.000Z"), asOf)).toBe("d31_60");
  });
  it("only ages unpaid (sent) invoices", () => {
    const totals = ageInvoices([
      inv("1","c1",5000,"sent","2026-07-25T00:00:00.000Z"),
      inv("2","c1",9999,"paid","2026-07-25T00:00:00.000Z"),
    ], asOf);
    expect(totals.current).toBe(5000);
  });
  it("sums a customer's open balance", () => {
    expect(customerBalanceCents([
      inv("1","c1",5000,"sent","2026-07-25T00:00:00.000Z"),
      inv("2","c1",3000,"sent","2026-07-10T00:00:00.000Z"),
      inv("3","c2",1000,"sent","2026-07-10T00:00:00.000Z"),
    ], "c1")).toBe(8000);
  });
});
