import { describe, it, expect } from "vitest";
import { createMockRepositories } from "@/lib/data/mock/repositories";

describe("mock repositories", () => {
  it("lists seeded customers", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const customers = await repos.customers.list();
    expect(customers.find((c) => c.name === "Apex Aerospace")).toBeTruthy();
  });
  it("creates a quote with a generated id + bumped number", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const q = await repos.quotes.create({
      rev: 0, customerId: "cust-apex", customerPO: "", status: "draft",
      salespersonId: "op-vance", date: "2026-06-30T00:00:00.000Z", validUntil: "2026-07-30T00:00:00.000Z",
      requiredBy: null, discount: null, estCostCents: 0, notes: "", wonOrderId: null, parts: [],
    });
    expect(q.id).toBeTruthy();
    expect(q.version).toBe(0);
    expect(q.number).toMatch(/^Q-/);
  });
  it("enforces optimistic concurrency on update", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const [q] = await repos.quotes.list();
    await expect(repos.quotes.update(q.id, { notes: "x" }, q.version + 5)).rejects.toThrow();
    const ok = await repos.quotes.update(q.id, { notes: "x" }, q.version);
    expect(ok.version).toBe(q.version + 1);
  });
});

describe("create()/number seam", () => {
  it("auto-numbers a work order on create (no explicit number in input)", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const wo = await repos.workOrders.create({
      customerId: "cust-apex", customerPO: "PO-1", quoteId: null,
      processSummary: "Carburize", processMasterId: null, status: "received",
      orderedDate: "2026-06-30T00:00:00.000Z", due: "2026-07-10T00:00:00.000Z",
      certifyRequired: false, certSpecId: null, orderValueCents: 1000, progressPct: 0,
      lines: [], pricing: [], steps: [], activity: [],
    });
    expect(wo.number).toBe("WO-48212"); // seed counter WO- = 48211 → next 48212
  });

  it("preserves number:null on a to-bill invoice create (does NOT auto-assign INV-)", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    const inv = await repos.invoices.create({
      number: null, customerId: "cust-apex", workOrderId: "wo-48211",
      amountCents: 5000, status: "to_bill",
      shippedDate: "2026-06-30T00:00:00.000Z", invoicedDate: null, paidDate: null,
    });
    expect(inv.number).toBeNull();
  });

  it("numbers.next assigns sequential INV- numbers from the seed counter", async () => {
    const repos = createMockRepositories({ latencyMs: 0 });
    expect(await repos.numbers.next("invoices")).toBe("INV-30413"); // seed INV- = 30412 → next 30413
    expect(await repos.numbers.next("invoices")).toBe("INV-30414");
  });
});
