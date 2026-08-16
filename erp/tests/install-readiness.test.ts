import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { installReadiness } from "@/server/install-readiness";
import { GET } from "@/app/api/setup/readiness/route";
import { setSetupState } from "@/server/setup-state";
import { hashPassword } from "@/server/password";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);
const noParams = { params: Promise.resolve({}) };
const getReq = (cookie: string) => new Request("http://t/api/setup/readiness", { headers: { cookie } });
const step = (r: Awaited<ReturnType<typeof installReadiness>>, key: string) => r.steps.find((s) => s.key === key);

describe("installReadiness rollup (Phase 8B §5.5)", () => {
  beforeEach(truncateAll);

  it("returns the eight steps in dependency order, blocking flags only on company + chart", async () => {
    const r = await installReadiness();
    expect(r.steps.map((s) => s.key)).toEqual([
      "password", "company", "numbers", "chart", "stepCodes", "references", "customers", "parts",
    ]);
    expect(r.steps.filter((s) => s.blocking).map((s) => s.key)).toEqual(["company", "chart"]);
  });

  it("company + chart flip to complete when the gate prereqs are seeded", async () => {
    let r = await installReadiness();
    expect(step(r, "company")?.complete).toBe(false);
    expect(step(r, "chart")?.complete).toBe(false);
    await seedOrderGatePrereqs();
    r = await installReadiness();
    expect(step(r, "company")?.complete).toBe(true);
    expect(step(r, "chart")?.complete).toBe(true);
  });

  it("password step is incomplete while the seeded admin still verifies 'admin', complete once changed", async () => {
    // No admin user → nothing to nudge, step reads complete.
    expect(step(await installReadiness(), "password")?.complete).toBe(true);

    const role = await prisma.role.create({ data: { name: "Admin" } });
    const admin = await prisma.user.create({
      data: { username: "admin", displayName: "Admin", passwordHash: await hashPassword("admin"), roleId: role.id },
    });
    expect(step(await installReadiness(), "password")?.complete).toBe(false);

    await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: await hashPassword("something-else") } });
    expect(step(await installReadiness(), "password")?.complete).toBe(true);
  });

  it("numbers-confirmed and dismissed come from SetupState", async () => {
    let r = await installReadiness();
    expect(step(r, "numbers")?.complete).toBe(false);
    expect(r.dismissed).toBe(false);

    await asSystem(() => setSetupState({ numbersConfirmedAt: new Date(), checklistDismissedAt: new Date() }));
    r = await installReadiness();
    expect(step(r, "numbers")?.complete).toBe(true);
    expect(r.dismissed).toBe(true);
  });

  it("stepCodes / customers / parts flip on their live counts", async () => {
    await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
    const cust = await prisma.customer.create({ data: { code: "C1", name: "Cust" } });
    await prisma.part.create({ data: { customerId: cust.id, partNumber: "P1", name: "Part", eachWeight: "1.0" } });
    const r = await installReadiness();
    expect(step(r, "stepCodes")?.complete).toBe(true);
    expect(step(r, "customers")?.complete).toBe(true);
    expect(step(r, "parts")?.complete).toBe(true);
  });
});

describe("GET /api/setup/readiness", () => {
  beforeEach(truncateAll);

  it("403 for a caller without admin.view", async () => {
    const cookie = await signInWith(["orders.view"], "no-admin");
    expect((await GET(getReq(cookie), noParams)).status).toBe(403);
  });

  it("200 behind admin.view, returns the eight steps", async () => {
    const cookie = await signInWith(["admin.view"], "admin-viewer");
    const res = await GET(getReq(cookie), noParams);
    expect(res.status).toBe(200);
    expect((await res.json()).steps).toHaveLength(8);
  });
});
