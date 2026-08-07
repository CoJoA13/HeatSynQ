import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import {
  listSurcharges, createSurcharge, deleteSurcharge, setSurchargeStepCodes, setCustomerSurcharge,
} from "@/server/surcharges";
import { deleteStepCode } from "@/server/process-step-codes";
import { findBlockers } from "@/server/reference-blockers";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

describe("surcharges", () => {
  beforeEach(truncateAll);

  it("creates a percent surcharge and lists it with its GL account name", async () => {
    const gl = await prisma.glAccount.create({ data: { name: "4200", description: "Energy surcharge" } });
    await asSystem(() => createSurcharge({
      name: "EnergySur", kind: "PERCENT", rate: "0.040000", glAccountId: gl.id, scope: "ALL", position: 1 }));
    const rows = await listSurcharges();
    expect(rows[0].name).toBe("EnergySur");
    expect(rows[0].rate).toBe(0.04);
    expect(rows[0].glAccountName).toBe("4200");
    expect(rows[0].needsGlAccount).toBe(false);
  });

  it("requires a rate for PERCENT and an amount for FLAT, and rejects both", async () => {
    await expect(asSystem(() => createSurcharge({ name: "A", kind: "PERCENT", position: 1 })))
      .rejects.toThrow("A percent surcharge needs a rate");
    await expect(asSystem(() => createSurcharge({ name: "B", kind: "FLAT", position: 1 })))
      .rejects.toThrow("A flat surcharge needs an amount");
    await expect(asSystem(() => createSurcharge({
      name: "C", kind: "PERCENT", rate: "0.04", amount: "5.00", position: 1 })))
      .rejects.toThrow("A percent surcharge cannot also carry a flat amount");
  });

  it("re-uses a soft-deleted name as a genuinely new row", async () => {
    const { id: first } = await asSystem(() => createSurcharge({ name: "EnergySur", kind: "FLAT", amount: "5.00", position: 1 }));
    await asSystem(() => deleteSurcharge(first));
    const { id: second } = await asSystem(() => createSurcharge({ name: "EnergySur", kind: "FLAT", amount: "6.00", position: 1 }));
    expect(second).not.toBe(first);
  });

  it("replaces the step-code list wholesale", async () => {
    const a = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper" } });
    const b = await prisma.processStepCode.create({ data: { code: "WASH", name: "Hot wash" } });
    const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", scope: "EXCLUDE", position: 1 }));
    await asSystem(() => setSurchargeStepCodes(id, [a.id, b.id]));
    await asSystem(() => setSurchargeStepCodes(id, [b.id]));
    const rows = await listSurcharges();
    expect(rows[0].stepCodeIds).toEqual([b.id]);
  });

  it("refuses to delete a surcharge a customer rule points at, and names the blocker", async () => {
    const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme" } });
    const { id } = await asSystem(() => createSurcharge({ name: "S", kind: "FLAT", amount: "1.00", position: 1 }));
    await asSystem(() => setCustomerSurcharge(customer.id, id, { optOut: true }));
    await expect(asSystem(() => deleteSurcharge(id))).rejects.toThrow(/still in use by 1 record/);
    const blockers = await findBlockers("surcharge", id);
    expect(blockers[0].entityLabel).toBe("Customer");
    expect(blockers[0].name).toContain("ACME");
  });

  // Task 2 hand-wrote SURCHARGE_VIA_STEP_CODE to repair a defect in this plan's own registry
  // snippet; its displayName/blockerId have never run. SurchargeStepCode is a join row with no
  // name of its own, so without them a blocker panel would show a bare cuid at a person.
  it("refuses to delete a step code a surcharge scopes on, naming the surcharge", async () => {
    const code = await prisma.processStepCode.create({ data: { code: "WASH", name: "Hot wash" } });
    const { id } = await asSystem(() => createSurcharge({
      name: "EnergySur", kind: "FLAT", amount: "1.00", scope: "EXCLUDE", position: 1 }));
    await asSystem(() => setSurchargeStepCodes(id, [code.id]));
    await expect(asSystem(() => deleteStepCode(code.id))).rejects.toThrow(/still in use by 1 record/);
    const blockers = await findBlockers("processStepCode", code.id);
    expect(blockers.some((b) => b.name.includes("EnergySur"))).toBe(true);
  });
});
