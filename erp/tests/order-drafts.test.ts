import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { getDraft, putDraft, clearDraft } from "@/server/order-drafts";

async function user(username: string) {
  return prisma.user.create({ data: { username, passwordHash: "x", displayName: username } });
}

describe("order drafts (the unaudited exception, spec §4)", () => {
  beforeEach(async () => await truncateAll());

  it("has no draft for a user who never saved one", async () => {
    const u = await user("op1");
    expect(await getDraft(u.id)).toBeNull();
  });

  it("round-trips a draft payload", async () => {
    const u = await user("op1");
    const payload = { customerId: "c1", lines: [{ partId: "p1", qty: 5 }] };
    await putDraft(u.id, payload);
    const draft = await getDraft(u.id);
    expect(draft?.payload).toEqual(payload);
    expect(draft?.updatedAt).toBeInstanceOf(Date);
  });

  it("upserts on repeated puts, keeping exactly one row per user", async () => {
    const u = await user("op1");
    await putDraft(u.id, { a: 1 });
    await putDraft(u.id, { a: 2 });
    expect(await prisma.orderDraft.count({ where: { userId: u.id } })).toBe(1);
    expect((await getDraft(u.id))?.payload).toEqual({ a: 2 });
  });

  it("clear nulls the payload but keeps the row (an update, not a delete)", async () => {
    const u = await user("op1");
    await putDraft(u.id, { a: 1 });
    await clearDraft(u.id);
    const row = await prisma.orderDraft.findUnique({ where: { userId: u.id } });
    expect(row).not.toBeNull();
    expect(row?.payload).toBeNull();
    expect((await getDraft(u.id))?.payload).toBeNull();
  });

  it("clearing a user with no draft row at all is a harmless no-op", async () => {
    const u = await user("op1");
    await expect(clearDraft(u.id)).resolves.toBeUndefined();
    expect(await getDraft(u.id)).toBeNull();
  });

  it("rejects a payload over 256 KB serialized, naming the limit, and writes nothing", async () => {
    const u = await user("op1");
    const big = { blob: "x".repeat(300 * 1024) };
    await expect(putDraft(u.id, big)).rejects.toMatchObject({ status: 400 });
    await expect(putDraft(u.id, big)).rejects.toThrow(/256 ?KB/i);
    expect(await getDraft(u.id)).toBeNull();
  });

  it("accepts a payload comfortably under the 256 KB cap", async () => {
    const u = await user("op1");
    const ok = { blob: "x".repeat(100 * 1024) };
    await expect(putDraft(u.id, ok)).resolves.toBeUndefined();
    expect((await getDraft(u.id))?.payload).toEqual(ok);
  });

  it("writes no audit rows for put, get, or clear (the §12.7 assertion)", async () => {
    const u = await user("op1");
    await putDraft(u.id, { a: 1 });
    await getDraft(u.id);
    await clearDraft(u.id);
    await putDraft(u.id, { a: 2 });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("keeps drafts isolated per user — one user's writes never touch another's", async () => {
    const a = await user("opA");
    const b = await user("opB");
    await putDraft(a.id, { who: "a" });
    await putDraft(b.id, { who: "b" });

    await clearDraft(a.id);

    expect((await getDraft(a.id))?.payload).toBeNull();
    expect((await getDraft(b.id))?.payload).toEqual({ who: "b" });
  });
});
