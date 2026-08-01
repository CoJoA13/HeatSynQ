import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { auditedCreate } from "@/server/audit";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("audited helpers are transactional", () => {
  beforeEach(truncateAll);

  it("rolls the audit row back with the mutation when the transaction aborts", async () => {
    await expect(asSystem(() => prisma.$transaction(async (tx) => {
      await auditedCreate("carrier", { name: "Doomed" }, () =>
        tx.carrier.create({ data: { name: "Doomed" } }), { tx });
      throw new Error("boom");
    }))).rejects.toThrow("boom");

    expect(await prisma.carrier.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { entity: "carrier" } })).toBe(0);
  });

  it("commits the audit row with the mutation when the transaction succeeds", async () => {
    await asSystem(() => prisma.$transaction(async (tx) => {
      await auditedCreate("carrier", { name: "Kept" }, () =>
        tx.carrier.create({ data: { name: "Kept" } }), { tx });
    }));
    expect(await prisma.auditLog.count({ where: { entity: "carrier", action: "create" } })).toBe(1);
  });
});
