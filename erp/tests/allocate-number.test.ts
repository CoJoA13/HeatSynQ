import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, prisma } from "./helpers/db";
import { allocateNumber, type NumberSettingKey } from "@/server/settings";
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

  // Fired without awaiting between starts, so which transaction actually reaches Postgres first
  // is not controlled by JS call order. This proves the outcome (two concurrent allocations never
  // collide or skip), not the mechanism — it does not by itself isolate the FOR UPDATE claim as
  // the cause, so the assertion is on distinctness and consecutiveness, not on which promise
  // resolves to which number.
  it("two concurrent transactions each allocating get distinct, consecutive numbers", async () => {
    const p1 = prisma.$transaction((tx) => allocateNumber("order_number_next", tx));
    const p2 = prisma.$transaction((tx) => allocateNumber("order_number_next", tx));
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).not.toBe(b);
    expect([a, b].sort((x, y) => x - y)).toEqual([1000, 1001]);
  });

  // The two-way test above only fails on a machine whose transactions actually overlap — it passed
  // for five phases on slower hardware while `allocateNumber` seeded its counter row with a
  // non-atomic `upsert(… update: {})` (Prisma emits SELECT-then-INSERT for an EMPTY update, not
  // `INSERT … ON CONFLICT`), and went red the first time it ran on a faster box. Widening the burst
  // widens the overlap window, so the seeding race is pinned on slow hardware too: every allocation
  // must be handed out exactly once, and none may be rejected by the primary key.
  it("a burst of concurrent allocations from an unseeded counter never collides or skips", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => prisma.$transaction((tx) => allocateNumber("order_number_next", tx))),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

    const numbers = results
      .map((r) => (r as PromiseFulfilledResult<number>).value)
      .sort((a, b) => a - b);
    expect(numbers).toEqual([1000, 1001, 1002, 1003, 1004]);
  });

  it("writes no audit row", async () => {
    await prisma.$transaction((tx) => allocateNumber("order_number_next", tx));
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("rejects an unknown key", async () => {
    await expect(prisma.$transaction((tx) => allocateNumber("bogus_key" as NumberSettingKey, tx)))
      .rejects.toMatchObject({ status: 400 });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("rejects an unknown key with an HttpError instance", async () => {
    const err = await prisma.$transaction((tx) => allocateNumber("bogus_key" as NumberSettingKey, tx))
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
  });

  it("allocates from a new numbering key", async () => {
    const n = await prisma.$transaction((tx) => allocateNumber("bol_number_next", tx));
    expect(n).toBe(1000);
    const again = await prisma.$transaction((tx) => allocateNumber("bol_number_next", tx));
    expect(again).toBe(1001);
  });

  it("refuses a non-numbering key at runtime", async () => {
    await expect(
      prisma.$transaction((tx) =>
        // @ts-expect-error — NumberSettingKey excludes this; the runtime guard is the backstop
        allocateNumber("company_name", tx)),
    ).rejects.toThrow(/not a numbering key/i);
  });

  it("allocates credit numbers from the new counter", async () => {
    const first = await prisma.$transaction((tx) => allocateNumber("credit_number_next", tx));
    const second = await prisma.$transaction((tx) => allocateNumber("credit_number_next", tx));
    expect(first).toBe(1000);
    expect(second).toBe(1001);
  });

  it("allocates receipt-batch numbers from the new counter", async () => {
    const first = await prisma.$transaction((tx) => allocateNumber("receipt_batch_number_next", tx));
    const second = await prisma.$transaction((tx) => allocateNumber("receipt_batch_number_next", tx));
    expect(first).toBe(1000);
    expect(second).toBe(1001);
  });

  // Fix-wave finding 8: Order.orderNumber is a Postgres INTEGER (int4) column, so a value past
  // 2147483647 can never be written there — allocating one anyway would only fail later, deep
  // inside the order-create transaction, as an opaque database error rather than this clean 400.
  describe("Int4 overflow", () => {
    it("allocates the last valid value (Int4 max) without refusing", async () => {
      await prisma.setting.create({ data: { key: "order_number_next", value: 2_147_483_647 } });
      const n = await prisma.$transaction((tx) => allocateNumber("order_number_next", tx));
      expect(n).toBe(2_147_483_647);
    });

    it("refuses to allocate past Int4 max, naming the setting, and writes nothing further", async () => {
      // One past Int4 max: reachable in practice because allocateNumber's own increment (above)
      // stores `current + 1` in the Json `value` column, which happily holds 2147483648 even
      // though that value could never be handed out as an actual orderNumber.
      await prisma.setting.create({ data: { key: "order_number_next", value: 2_147_483_648 } });

      const err = await prisma.$transaction((tx) => allocateNumber("order_number_next", tx)).catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).message).toContain("order_number_next");

      // Refused BEFORE the increment write — the stored value is untouched, not quietly bumped
      // to 2147483649 or reset back to the seed default (either of which would risk reissuing an
      // already-used order number on the next call).
      const row = await prisma.setting.findUnique({ where: { key: "order_number_next" } });
      expect(row?.value).toBe(2_147_483_648);
      expect(await prisma.auditLog.count()).toBe(0);
    });
  });
});
