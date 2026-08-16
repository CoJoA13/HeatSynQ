import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { orderEntryReadiness } from "@/server/order-entry-readiness";
import { setSetting } from "@/server/settings";
import { setBillingConfig } from "@/server/billing-config";
import { runWithContext } from "@/server/context";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

async function setCompanyIdentity() {
  await asSystem(async () => {
    await setSetting("company_name", "Acme Heat Treat");
    await setSetting("company_address", "1 Furnace Rd, Anytown");
    await setSetting("company_phone", "555-0100");
  });
}

async function setChartOfAccounts() {
  const gl = await prisma.glAccount.create({ data: { name: "1200", description: "A/R" } });
  await asSystem(() => setBillingConfig({ arGlAccountId: gl.id }));
}

describe("orderEntryReadiness (Phase 8B §5.6)", () => {
  beforeEach(truncateAll);

  it("is not ready with a company-identity gap when a company field is blank", async () => {
    await setChartOfAccounts(); // chart done, identity blank (default "")
    const r = await orderEntryReadiness();
    expect(r.ready).toBe(false);
    expect(r.gaps.some((g) => g.label.includes("Company identity") && g.href === "/admin/settings")).toBe(true);
  });

  it("flags both a no-GL-accounts gap and an A/R-account gap when the chart is unset", async () => {
    await setCompanyIdentity(); // identity done, chart blank (no GL accounts, arGl null)
    const r = await orderEntryReadiness();
    expect(r.ready).toBe(false);
    expect(r.gaps.some((g) => g.href === "/admin/reference")).toBe(true);
    expect(r.gaps.some((g) => g.href === "/admin/billing")).toBe(true);
    expect(r.gaps.some((g) => g.label.includes("Company identity"))).toBe(false);
  });

  it("is not ready when GL accounts exist but the A/R control account is unset", async () => {
    await setCompanyIdentity();
    await prisma.glAccount.create({ data: { name: "4010" } }); // a GL account exists, arGl still null
    const r = await orderEntryReadiness();
    expect(r.ready).toBe(false);
    expect(r.gaps.some((g) => g.label.includes("A/R control account"))).toBe(true);
    expect(r.gaps.some((g) => g.href === "/admin/reference")).toBe(false); // GL accounts now exist
  });

  it("is ready with no gaps when company identity and the chart are both set", async () => {
    await setCompanyIdentity();
    await setChartOfAccounts();
    const r = await orderEntryReadiness();
    expect(r.ready).toBe(true);
    expect(r.gaps).toEqual([]);
  });
});
