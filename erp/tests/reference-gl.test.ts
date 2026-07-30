import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { listReference, createReference, updateReference, deleteReference } from "@/server/reference";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";
import { GET as listRoute, POST as createRoute } from "@/app/api/admin/reference/[kind]/route";
import { signInWith } from "./helpers/auth";

describe("GL account reference", () => {
  beforeEach(async () => await truncateAll());

  it("creates, lists, and orders by name", async () => {
    await createReference("glAccount", { name: "4020", description: "Straightening Revenue" });
    await createReference("glAccount", { name: "4010", description: "Heat Treat Revenue" });
    const rows = await listReference("glAccount");
    expect(rows.map((r) => r.name)).toEqual(["4010", "4020"]);
    expect(rows[0]).toMatchObject({ description: "Heat Treat Revenue", active: true });
  });

  it("rejects a duplicate account number", async () => {
    await createReference("glAccount", { name: "4010" });
    await expect(createReference("glAccount", { name: "4010" })).rejects.toThrow(HttpError);
  });

  it("soft deletes — the row leaves the list but survives in the table", async () => {
    const { id } = await createReference("glAccount", { name: "4010" });
    await deleteReference("glAccount", id);
    expect(await listReference("glAccount")).toHaveLength(0);
    expect(await prisma.glAccount.findUnique({ where: { id } })).not.toBeNull();
  });

  it("hides inactive rows unless asked", async () => {
    const { id } = await createReference("glAccount", { name: "4010" });
    await updateReference("glAccount", id, { active: false });
    expect(await listReference("glAccount")).toHaveLength(0);
    expect(await listReference("glAccount", { includeInactive: true })).toHaveLength(1);
  });

  it("audits every mutation with a usable diff", async () => {
    const { id } = await createReference("glAccount", { name: "4010", description: "Heat Treat" });
    await updateReference("glAccount", id, { description: "Heat Treat Revenue" });
    const entries = await readAudit("glAccount", id);
    expect(entries.map((e) => e.action)).toEqual(["update", "create"]);
    expect((entries[0].before as { description: string }).description).toBe("Heat Treat");
    expect((entries[0].after as { description: string }).description).toBe("Heat Treat Revenue");
  });

  it("404s on an unknown id and rejects an unknown kind", async () => {
    await expect(updateReference("glAccount", "nope", { name: "x" })).rejects.toMatchObject({ status: 404 });
    // `kind` is typed `string` on purpose so routes can pass a raw path segment — the guard
    // is runtime, not compile time. No @ts-expect-error here: the call type-checks fine, and
    // an unused directive is a hard tsc failure (TS2578).
    await expect(listReference("notAKind")).rejects.toMatchObject({ status: 400 });
  });
});

describe("reference routes", () => {
  beforeEach(async () => await truncateAll());
  const ctx = { params: Promise.resolve({ kind: "glAccount" }) };

  it("401s without a session", async () => {
    const res = await listRoute(new Request("http://t/api/admin/reference/glAccount"), ctx);
    expect(res.status).toBe(401);
  });

  it("403s for a signed-in user without admin.create", async () => {
    const cookie = await signInWith(["admin.view"]);

    const ok = await listRoute(new Request("http://t/api/admin/reference/glAccount", { headers: { cookie } }), ctx);
    expect(ok.status).toBe(200);

    const denied = await createRoute(new Request("http://t/api/admin/reference/glAccount", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "4010" }),
    }), ctx);
    expect(denied.status).toBe(403);
  });
});
