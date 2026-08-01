import { describe, it, expect, beforeEach } from "vitest";
import { ZodError } from "zod";
import { prisma, truncateAll } from "./helpers/db";
import { listReference, createReference, updateReference, deleteReference } from "@/server/reference";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";
import { REFERENCE_KINDS } from "@/lib/reference-constants";
import { GET as listRoute, POST as createRoute } from "@/app/api/admin/reference/[kind]/route";
import { PUT as updateRoute, DELETE as deleteRoute } from "@/app/api/admin/reference/[kind]/[id]/route";
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

  it("rejects an unknown field on create instead of silently dropping it", async () => {
    await expect(
      createReference("glAccount", { name: "4010", descriptoin: "typo", mysteryField: 123 }),
    ).rejects.toThrow(ZodError);
    expect(await listReference("glAccount")).toHaveLength(0);
  });

  it("rejects an unknown field on update instead of silently dropping it", async () => {
    const { id } = await createReference("glAccount", { name: "4010", description: "Heat Treat" });
    await expect(updateReference("glAccount", id, { descriptoin: "typo" })).rejects.toThrow(ZodError);
    const [row] = await listReference("glAccount");
    expect(row.description).toBe("Heat Treat");
  });

  it("revives a soft-deleted row when the same name is re-created", async () => {
    const { id: firstId } = await createReference("glAccount", { name: "4010", description: "Heat Treat" });
    await deleteReference("glAccount", firstId);
    expect(await listReference("glAccount")).toHaveLength(0);

    const { id: secondId } = await createReference("glAccount", { name: "4010", description: "Revived" });
    expect(secondId).toBe(firstId);

    const rows = await prisma.glAccount.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).toBeNull();
    expect(rows[0].description).toBe("Revived");
    expect(await listReference("glAccount")).toHaveLength(1);
  });

  it("still rejects a duplicate when the existing row is not soft-deleted", async () => {
    await createReference("glAccount", { name: "4010" });
    await expect(createReference("glAccount", { name: "4010" })).rejects.toMatchObject({ status: 400 });
    expect(await prisma.glAccount.findMany()).toHaveLength(1);
  });

  it("revival resets extra fields a genuine create would default, not just active", async () => {
    // Fix 3 (final review): `description` is optional on createReference's input, so a revived
    // GL account used to keep its predecessor's description when the caller didn't supply one.
    // Drift-proof the way customers.test.ts's equivalent test is: compare two field-for-field
    // rows rather than asserting a literal default value.
    const fresh = await createReference("glAccount", { name: "9999" });
    const [freshRow] = await listReference("glAccount", { includeInactive: true });

    const { id } = await createReference("glAccount", { name: "4010", description: "Old description" });
    await deleteReference("glAccount", id);

    const revived = await createReference("glAccount", { name: "4010" });
    expect(revived.id).toBe(id);
    const revivedRow = (await listReference("glAccount", { includeInactive: true })).find((r) => r.id === id)!;

    // listReference returns every column, including createdAt/updatedAt — genuinely distinct
    // timestamps between the two rows, not part of what revival is being checked against.
    const identityFields = ["id", "name", "createdAt", "updatedAt"] as const;
    const omitIdentity = (row: typeof freshRow) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => !(identityFields as readonly string[]).includes(k)));
    expect(omitIdentity(revivedRow)).toEqual(omitIdentity(freshRow));
    expect(fresh.id).not.toBe(revived.id);
  });

  it("revives a soft-deleted, previously-inactive row as active by default", async () => {
    const { id } = await createReference("glAccount", { name: "4010" });
    await updateReference("glAccount", id, { active: false });
    await deleteReference("glAccount", id);

    await createReference("glAccount", { name: "4010" });

    // A caller who gets no error back on create must see the row in a plain, default list —
    // reviving it still `active: false` would make it invisible with no signal anything is wrong.
    expect(await listReference("glAccount")).toHaveLength(1);
  });
});

describe("reference delegate contract", () => {
  beforeEach(async () => await truncateAll());

  // Guards the generic service's assumption (baked into RefDelegate in src/server/reference.ts)
  // that every reference kind's Prisma model exposes id/name/active/deletedAt through the usual
  // findMany/create/update calls. Runs against every kind in REFERENCE_KINDS, so a future entity
  // (Task 6+) that's missing one of these columns fails here — loudly, with a clear assertion —
  // instead of surfacing as an opaque Prisma runtime error inside delegate().
  it.each(REFERENCE_KINDS)("kind %s round-trips id/name/active/deletedAt through the generic service", async (kind) => {
    const { id } = await createReference(kind, { name: `contract-${kind}` });

    const [row] = await listReference(kind, { includeInactive: true });
    expect(row).toMatchObject({ id, name: `contract-${kind}`, active: true });

    await updateReference(kind, id, { active: false });
    expect(await listReference(kind)).toHaveLength(0);
    expect(await listReference(kind, { includeInactive: true })).toHaveLength(1);

    await deleteReference(kind, id);
    expect(await listReference(kind, { includeInactive: true })).toHaveLength(0);
  });

  // Revival-on-create is still in place until Task 7 removes it — un-skip there.
  it.skip("permits a deleted row and a live row to share a name, but not two live rows", async () => {
    const first = await createReference("material", { name: "4140" });
    await deleteReference("material", first.id);

    // The whole point of the partial index: the archived row keeps its real name.
    const archived = await prisma.material.findUnique({ where: { id: first.id } });
    expect(archived?.name).toBe("4140");
    expect(archived?.deletedAt).not.toBeNull();

    // A live row may now take that name — and is a genuinely new row.
    const second = await createReference("material", { name: "4140" });
    expect(second.id).not.toBe(first.id);

    // But two live rows may not.
    await expect(createReference("material", { name: "4140" })).rejects.toThrow(/already exists/i);
  });
});

describe("reference routes", () => {
  beforeEach(async () => await truncateAll());
  const ctx = { params: Promise.resolve({ kind: "glAccount" }) };
  const idCtx = { params: Promise.resolve({ kind: "glAccount", id: "placeholder" }) };

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

  it("401s on PUT and DELETE without a session", async () => {
    const putRes = await updateRoute(new Request("http://t/api/admin/reference/glAccount/placeholder", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }),
    }), idCtx);
    expect(putRes.status).toBe(401);

    const deleteRes = await deleteRoute(
      new Request("http://t/api/admin/reference/glAccount/placeholder", { method: "DELETE" }), idCtx,
    );
    expect(deleteRes.status).toBe(401);
  });

  it("403s for a signed-in user without admin.edit or admin.delete", async () => {
    const cookie = await signInWith(["admin.view"]);

    const putRes = await updateRoute(new Request("http://t/api/admin/reference/glAccount/placeholder", {
      method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }),
    }), idCtx);
    expect(putRes.status).toBe(403);

    const deleteRes = await deleteRoute(new Request("http://t/api/admin/reference/glAccount/placeholder", {
      method: "DELETE", headers: { cookie },
    }), idCtx);
    expect(deleteRes.status).toBe(403);
  });
});
