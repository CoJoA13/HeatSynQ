import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { listViews, createView, updateView, deleteView } from "@/server/saved-views";
import * as audit from "@/server/audit";
const { readAudit } = audit;

async function user(username: string) {
  return prisma.user.create({ data: { username, passwordHash: "x", displayName: username } });
}

describe("saved views", () => {
  beforeEach(async () => await truncateAll());

  it("creates a view and lists it back for its owner", async () => {
    const u = await user("op1");
    const view = await createView(u.id, { name: "My board", config: { columns: ["a"] } });
    expect(view).toMatchObject({ name: "My board", config: { columns: ["a"] }, isDefault: false });
    const rows = await listViews(u.id);
    expect(rows.map((r) => r.id)).toEqual([view.id]);
  });

  it("updates name, config, and isDefault", async () => {
    const u = await user("op1");
    const view = await createView(u.id, { name: "A", config: { x: 1 } });
    const updated = await updateView(u.id, view.id, { name: "B", config: { x: 2 }, isDefault: true });
    expect(updated).toMatchObject({ id: view.id, name: "B", config: { x: 2 }, isDefault: true });
    expect((await listViews(u.id))[0]).toMatchObject({ name: "B", config: { x: 2 } });
  });

  it("soft-deletes a view: gone from the list, row still present", async () => {
    const u = await user("op1");
    const view = await createView(u.id, { name: "A", config: {} });
    await deleteView(u.id, view.id);
    expect(await listViews(u.id)).toEqual([]);
    const row = await prisma.savedView.findUnique({ where: { id: view.id } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
  });

  it("lets two different users use the exact same view name", async () => {
    const a = await user("opA");
    const b = await user("opB");
    await expect(createView(a.id, { name: "Same", config: {} })).resolves.toMatchObject({ name: "Same" });
    await expect(createView(b.id, { name: "Same", config: {} })).resolves.toMatchObject({ name: "Same" });
  });

  it("rejects a duplicate live name for the same user", async () => {
    const u = await user("op1");
    await createView(u.id, { name: "Same", config: {} });
    await expect(createView(u.id, { name: "Same", config: {} }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("cross-user access is structurally impossible: same 404 whether the id is wrong-owner or missing", async () => {
    const a = await user("opA");
    const b = await user("opB");
    const view = await createView(a.id, { name: "A's board", config: {} });

    expect(await listViews(b.id)).toEqual([]);

    await expect(updateView(b.id, "nonexistent-id", { name: "x" }))
      .rejects.toMatchObject({ status: 404, message: "Saved view not found" });
    await expect(updateView(b.id, view.id, { name: "x" }))
      .rejects.toMatchObject({ status: 404, message: "Saved view not found" });

    await expect(deleteView(b.id, "nonexistent-id"))
      .rejects.toMatchObject({ status: 404, message: "Saved view not found" });
    await expect(deleteView(b.id, view.id))
      .rejects.toMatchObject({ status: 404, message: "Saved view not found" });

    // untouched by any of the above
    expect((await listViews(a.id)).map((r) => r.id)).toEqual([view.id]);
  });

  it("setting a new default on create clears the previous default (normalizer)", async () => {
    const u = await user("op1");
    const a = await createView(u.id, { name: "A", config: {}, isDefault: true });
    const b = await createView(u.id, { name: "B", config: {}, isDefault: true });
    const rows = await listViews(u.id);
    expect(rows.find((r) => r.id === a.id)?.isDefault).toBe(false);
    expect(rows.find((r) => r.id === b.id)?.isDefault).toBe(true);
  });

  it("promoting an existing view to default via update clears the previous default", async () => {
    const u = await user("op1");
    const a = await createView(u.id, { name: "A", config: {}, isDefault: true });
    const b = await createView(u.id, { name: "B", config: {} });
    await updateView(u.id, b.id, { isDefault: true });
    const rows = await listViews(u.id);
    expect(rows.find((r) => r.id === a.id)?.isDefault).toBe(false);
    expect(rows.find((r) => r.id === b.id)?.isDefault).toBe(true);
  });

  // The customer-addresses.ts precedent (tests/customer-children.test.ts, "rolls the soft delete
  // back if the fused normalization fails"): demoteOtherDefaults writes through auditedUpdate
  // inside the SAME transaction as the create it guards, so forcing that one write to fail must
  // roll back the whole thing — not leave a demoted A sitting next to a B that never committed.
  it("rolls the whole create back if the fused default-demotion fails (normalizer shares the write's own tx)", async () => {
    const u = await user("op1");
    const a = await createView(u.id, { name: "A", config: {}, isDefault: true });

    const spy = vi.spyOn(audit, "auditedUpdate").mockRejectedValueOnce(new Error("boom"));
    try {
      await expect(createView(u.id, { name: "B", config: {}, isDefault: true })).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }

    expect(await prisma.savedView.findFirst({ where: { userId: u.id, name: "B" } })).toBeNull();
    expect((await prisma.savedView.findUnique({ where: { id: a.id } }))?.isDefault).toBe(true);
  });

  it("a different user's default is untouched by this user's default normalizer", async () => {
    const a = await user("opA");
    const b = await user("opB");
    const aView = await createView(a.id, { name: "A", config: {}, isDefault: true });
    await createView(b.id, { name: "B", config: {}, isDefault: true });
    expect((await listViews(a.id)).find((r) => r.id === aView.id)?.isDefault).toBe(true);
  });

  it("a soft-deleted view's name becomes reusable by the same user", async () => {
    const u = await user("op1");
    const first = await createView(u.id, { name: "Board 1", config: {} });
    await deleteView(u.id, first.id);
    const second = await createView(u.id, { name: "Board 1", config: {} });
    expect(second.id).not.toBe(first.id);
    expect(await listViews(u.id)).toHaveLength(1);
  });

  it("audits create, update, and delete with real before/after content", async () => {
    const u = await user("op1");
    const view = await createView(u.id, { name: "A", config: { x: 1 } });
    await updateView(u.id, view.id, { name: "B" });
    await deleteView(u.id, view.id);

    const entries = await readAudit("savedView", view.id);
    expect(entries.map((e) => e.action)).toEqual(["delete", "update", "create"]);

    const createEntry = entries[2];
    expect(createEntry.after).toMatchObject({ name: "A", userId: u.id });

    const updateEntry = entries[1];
    expect(updateEntry.before).toMatchObject({ name: "A" });
    expect(updateEntry.after).toMatchObject({ name: "B" });

    const deleteEntry = entries[0];
    expect(deleteEntry.before).toMatchObject({ name: "B" });
  });

  it("rejects an empty name, a too-long name, an unknown field, and a missing config", async () => {
    const u = await user("op1");
    await expect(createView(u.id, { name: "  ", config: {} })).rejects.toThrow();
    await expect(createView(u.id, { name: "x".repeat(81), config: {} })).rejects.toThrow();
    await expect(createView(u.id, { name: "ok", config: {}, bogus: 1 })).rejects.toThrow();
    await expect(createView(u.id, { name: "ok" })).rejects.toThrow();
  });

  it("trims the name", async () => {
    const u = await user("op1");
    const view = await createView(u.id, { name: "  Spaced  ", config: {} });
    expect(view.name).toBe("Spaced");
  });
});
