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
      number: "", rev: 0, customerId: "cust-apex", customerPO: "", status: "draft",
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
