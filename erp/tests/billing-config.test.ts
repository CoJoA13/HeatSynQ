import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { getBillingConfig, setBillingConfig } from "@/server/billing-config";
import { findBlockers } from "@/server/reference-blockers";
import { deleteReference } from "@/server/reference";
import { GET as getBillingRoute, PUT as putBillingRoute } from "@/app/api/admin/billing/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const noParams = { params: Promise.resolve({}) };

function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}
function bodyReq(url: string, method: string, cookie: string | undefined, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe("getBillingConfig / setBillingConfig", () => {
  beforeEach(truncateAll);

  it("returns the seeded singleton with everything unset", async () => {
    const cfg = await getBillingConfig();
    expect(cfg).toEqual({
      salesTaxRate: null, salesTaxGlAccountId: null, freightGlAccountId: null,
      otherChargeGlAccountId: null, certChargeStepCodeId: null,
      certChargeDefault: null, billForCertDefault: false, financeChargeRate: null,
    });
  });

  // The fallback branch, which truncateAll's re-seed would otherwise make unreachable: delete the
  // row first, so this test can actually fail if the `if (!row) return EMPTY` guard is removed.
  it("returns the defaults when the row is genuinely absent (a fresh clone, a restore)", async () => {
    await prisma.billingConfig.deleteMany({});
    const cfg = await getBillingConfig();
    expect(cfg.salesTaxRate).toBeNull();
    expect(cfg.billForCertDefault).toBe(false);
  });

  // Task 2 hand-wrote BILLING_CONFIG_BLOCKER to repair a defect in this plan's own registry
  // snippet, and nothing exercises its displayName/blockerId yet — the queries are proven valid
  // (they run on every GL-account delete), but no test has ever had a matching row. BillingConfig
  // has no `name` column, so findBlockers' default would print "singleton" at a user.
  it("refuses to delete a GL account the billing settings point at, naming it usefully", async () => {
    const gl = await prisma.glAccount.create({ data: { name: "4300", description: "Freight" } });
    await asSystem(() => setBillingConfig({ freightGlAccountId: gl.id }));
    await expect(asSystem(() => deleteReference("glAccount", gl.id)))
      .rejects.toThrow(/still in use by 1 record/);
    const blockers = await findBlockers("glAccount", gl.id);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].entityLabel).toBe("Billing settings");
    expect(blockers[0].name).not.toBe("singleton");     // a person must be able to read this
    expect(blockers[0].href).toBe("/admin/billing");
  });

  it("saves a rate and a GL account, and audits the diff", async () => {
    const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
    await asSystem(() => setBillingConfig({ salesTaxRate: "0.0400", salesTaxGlAccountId: gl.id }));
    const cfg = await getBillingConfig();
    expect(cfg.salesTaxRate).toBe(0.04);
    const entry = await prisma.auditLog.findFirst({
      where: { entity: "billingConfig", entityId: "singleton" }, orderBy: { at: "desc" } });
    const before = entry!.before as { salesTaxRate: string | null };
    const after = entry!.after as { salesTaxRate: string };
    expect(before.salesTaxRate).toBeNull();
    expect(Number(after.salesTaxRate)).toBe(0.04);
  });

  // Finding 1 (Task 3 review): the other tests in this file only ever exercise salesTaxRate /
  // salesTaxGlAccountId / billForCertDefault. otherChargeGlAccountId and certChargeDefault are
  // never written or read by any test at all, and salesTaxGlAccountId/freightGlAccountId are
  // read back straight off the DB row rather than through getBillingConfig's mapping. That gap
  // means a transposition inside getBillingConfig's seven-field mapping (e.g. reading
  // freightGlAccountId off row.otherChargeGlAccountId) would pass the whole suite. Three
  // *distinct* GL accounts are used so a transposition between any pair of the three GL fields
  // is caught — if they all pointed at the same account, swapping two field reads would be
  // invisible to `toBe`.
  it("round-trips all seven fields through a single save, none transposed", async () => {
    const glTax = await prisma.glAccount.create({ data: { name: "4010", description: "Sales tax payable" } });
    const glFreight = await prisma.glAccount.create({ data: { name: "4020", description: "Freight expense" } });
    const glOther = await prisma.glAccount.create({ data: { name: "4030", description: "Other charges" } });
    const code = await prisma.processStepCode.create({ data: { code: "CERTX", name: "Certification charge" } });

    await asSystem(() => setBillingConfig({
      salesTaxRate: "0.055000",
      salesTaxGlAccountId: glTax.id,
      freightGlAccountId: glFreight.id,
      otherChargeGlAccountId: glOther.id,
      certChargeStepCodeId: code.id,
      certChargeDefault: "125.50",
      billForCertDefault: true,
    }));

    const cfg = await getBillingConfig();
    expect(cfg.salesTaxRate).toBe(0.055);
    expect(cfg.salesTaxGlAccountId).toBe(glTax.id);
    expect(cfg.freightGlAccountId).toBe(glFreight.id);
    expect(cfg.otherChargeGlAccountId).toBe(glOther.id);
    expect(cfg.certChargeStepCodeId).toBe(code.id);
    expect(cfg.certChargeDefault).toBe(125.5);
    expect(cfg.billForCertDefault).toBe(true);
  });

  it("refuses a GL account that does not exist", async () => {
    await expect(asSystem(() => setBillingConfig({ freightGlAccountId: "nope" })))
      .rejects.toThrow("That gl account does not exist");
  });

  it("refuses a soft-deleted step code", async () => {
    const code = await prisma.processStepCode.create({ data: { code: "CERT", name: "Certification" } });
    await prisma.processStepCode.update({ where: { id: code.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => setBillingConfig({ certChargeStepCodeId: code.id })))
      .rejects.toThrow("That process step code does not exist");
  });

  // Task 4 (§4.3, §7): the plant default monthly finance-charge rate. Customer.financeChargeRate
  // (customers.ts) overrides this per customer; that override chain is Task 11/12's concern, not
  // this one — this only proves the plant-level setting itself reads/writes/validates.
  it("saves the plant finance-charge rate and reads it back", async () => {
    await asSystem(() => setBillingConfig({ financeChargeRate: "1.5" }));
    const cfg = await getBillingConfig();
    expect(cfg.financeChargeRate).toBe(1.5);
  });

  it("rejects a negative finance-charge rate", async () => {
    await expect(asSystem(() => setBillingConfig({ financeChargeRate: "-1" }))).rejects.toThrow();
  });
});

describe("GET/PUT /api/admin/billing", () => {
  beforeEach(truncateAll);

  it("requires login", async () => {
    expect((await getBillingRoute(getReq("http://t/api/admin/billing"), noParams)).status).toBe(401);
    expect((await putBillingRoute(bodyReq("http://t/api/admin/billing", "PUT", undefined, {}), noParams)).status)
      .toBe(401);
  });

  it("requires admin.view for GET and admin.edit for PUT", async () => {
    const noPerms = await signInWith(["customers.view"], "no-admin");
    expect((await getBillingRoute(getReq("http://t/api/admin/billing", noPerms), noParams)).status).toBe(403);

    const viewer = await signInWith(["admin.view"], "billing-viewer");
    expect((await getBillingRoute(getReq("http://t/api/admin/billing", viewer), noParams)).status).toBe(200);
    expect((await putBillingRoute(bodyReq("http://t/api/admin/billing", "PUT", viewer, {}), noParams)).status)
      .toBe(403);
  });

  it("GET/PUT succeed with admin.view/admin.edit", async () => {
    const editor = await signInWith(["admin.view", "admin.edit"], "billing-editor");
    const getRes = await getBillingRoute(getReq("http://t/api/admin/billing", editor), noParams);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({ salesTaxRate: null, billForCertDefault: false });

    const putRes = await putBillingRoute(
      bodyReq("http://t/api/admin/billing", "PUT", editor, { billForCertDefault: true }), noParams);
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toMatchObject({ billForCertDefault: true });
  });
});
