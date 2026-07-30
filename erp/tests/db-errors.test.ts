import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { withDbErrors } from "@/server/db-errors";
import { HttpError } from "@/server/errors";
import { createRole, renameRole } from "@/server/roles";

describe("db error hygiene", () => {
  beforeEach(async () => await truncateAll());

  it("maps a unique violation to 400", async () => {
    await prisma.role.create({ data: { name: "Office" } });
    const boom = withDbErrors({ entity: "Role", conflictField: "name" }, () =>
      prisma.role.create({ data: { name: "Office" } }));
    await expect(boom).rejects.toThrow(HttpError);
    await expect(boom).rejects.toMatchObject({ status: 400 });
  });

  it("maps a missing record to 404", async () => {
    const boom = withDbErrors({ entity: "Role" }, () =>
      prisma.role.update({ where: { id: "does-not-exist" }, data: { name: "x" } }));
    await expect(boom).rejects.toMatchObject({ status: 404, message: "Role not found" });
  });

  it("lets unrelated errors through untouched", async () => {
    const boom = withDbErrors({ entity: "Role" }, async () => { throw new Error("kaboom"); });
    await expect(boom).rejects.toThrow("kaboom");
    await expect(boom).rejects.not.toBeInstanceOf(HttpError);
  });

  it("renameRole on a bogus id is a 404, not a 500", async () => {
    await expect(renameRole("nope", "Whatever")).rejects.toMatchObject({ status: 404 });
  });

  it("createRole survives a concurrent duplicate insert", async () => {
    const results = await Promise.allSettled([createRole("Race"), createRole("Race")]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(HttpError);
    expect(await prisma.role.count({ where: { name: "Race" } })).toBe(1);
  });
});
