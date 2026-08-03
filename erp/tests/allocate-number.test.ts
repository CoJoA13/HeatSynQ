import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, prisma } from "./helpers/db";
import { allocateNumber, type SettingKey } from "@/server/settings";
import { HttpError } from "@/server/http";

describe("allocateNumber", () => {
  beforeEach(async () => await truncateAll());

  it("returns the seed default when no row exists, and persists it incremented", async () => {
    const n = await prisma.$transaction((tx) => allocateNumber("order_number_next", tx));
    expect(n).toBe(1000);

    const row = await prisma.setting.findUnique({ where: { key: "order_number_next" } });
    expect(row?.value).toBe(1001);
  });

  it("two sequential calls give N, N+1", async () => {
    const first = await prisma.$transaction((tx) => allocateNumber("order_number_next", tx));
    const second = await prisma.$transaction((tx) => allocateNumber("order_number_next", tx));
    expect(first).toBe(1000);
    expect(second).toBe(1001);
  });

  // Fired without awaiting between starts — the FOR UPDATE claim inside allocateNumber is what
  // has to serialize these, not JS call order, so the assertion is on distinctness and
  // consecutiveness, not on which promise resolves to which number.
  it("two concurrent transactions each allocating get distinct, consecutive numbers", async () => {
    const p1 = prisma.$transaction((tx) => allocateNumber("order_number_next", tx));
    const p2 = prisma.$transaction((tx) => allocateNumber("order_number_next", tx));
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).not.toBe(b);
    expect([a, b].sort((x, y) => x - y)).toEqual([1000, 1001]);
  });

  it("writes no audit row", async () => {
    await prisma.$transaction((tx) => allocateNumber("order_number_next", tx));
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("rejects an unknown key", async () => {
    await expect(prisma.$transaction((tx) => allocateNumber("bogus_key" as SettingKey, tx)))
      .rejects.toMatchObject({ status: 400 });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("rejects an unknown key with an HttpError instance", async () => {
    const err = await prisma.$transaction((tx) => allocateNumber("bogus_key" as SettingKey, tx)).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
  });
});
