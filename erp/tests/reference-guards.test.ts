import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createCustomer, updateCustomer } from "@/server/customers";
import { createReference, updateReference } from "@/server/reference";
import { createStepCode, updateStepCode } from "@/server/process-step-codes";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("FK writers validate their target in-transaction", () => {
  beforeEach(truncateAll);

  async function deadRow(model: "terms" | "glAccount" | "inspectionScale") {
    const row = await (prisma[model] as { create: (a: object) => Promise<{ id: string }> })
      .create({ data: { name: `dead-${model}`, deletedAt: new Date() } });
    return row.id;
  }

  it("customer.termsId: soft-deleted terms rejected on create and update", async () => {
    const dead = await deadRow("terms");
    await expect(asSystem(() => createCustomer({ code: "A", name: "A", termsId: dead })))
      .rejects.toThrow("That terms does not exist");
    const { id } = await asSystem(() => createCustomer({ code: "B", name: "B" }));
    await expect(asSystem(() => updateCustomer(id, { termsId: dead })))
      .rejects.toThrow("That terms does not exist");
  });

  it("inspectionCode.defaultScaleId: soft-deleted scale rejected even as a raw id", async () => {
    const dead = await deadRow("inspectionScale");
    await expect(asSystem(() => createReference("inspectionCode", { name: "HRC", defaultScaleId: dead })))
      .rejects.toThrow("That inspection scale does not exist");
    const { id } = await asSystem(() => createReference("inspectionCode", { name: "HB" }));
    await expect(asSystem(() => updateReference("inspectionCode", id, { defaultScaleId: dead })))
      .rejects.toThrow("That inspection scale does not exist");
  });

  it("paymentType.glAccountId and processStepCode.glAccountId: same", async () => {
    const dead = await deadRow("glAccount");
    await expect(asSystem(() => createReference("paymentType", { name: "Check", glAccountId: dead })))
      .rejects.toThrow("That gl account does not exist");
    await expect(asSystem(() => createStepCode({ code: "HT-01", name: "Austenitize", glAccountId: dead })))
      .rejects.toThrow("That gl account does not exist");
    const { id } = await asSystem(() => createStepCode({ code: "HT-02", name: "Temper" }));
    await expect(asSystem(() => updateStepCode(id, { glAccountId: dead })))
      .rejects.toThrow("That gl account does not exist");
  });

  it("an INACTIVE target is still assignable — inactive hides, it does not invalidate", async () => {
    const t = await prisma.terms.create({ data: { name: "Net 30", active: false } });
    const { id } = await asSystem(() => createCustomer({ code: "C", name: "C", termsId: t.id }));
    expect(id).toBeTruthy();
  });
});
