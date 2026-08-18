import { describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "../prisma/generated/prisma/client";
import { prisma, truncateAll } from "./helpers/db";
import { withDbErrors, translatePrisma, retryOnSerializationConflict } from "@/server/db-errors";
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

  // A serialization failure raised by a RAW query arrives as P2010 with the SQLSTATE buried in
  // the driver adapter's error, not as the P2034 a client-API call would produce. Same condition,
  // so it must reach the same 409 — without this it escaped as a 500. Reached in anger by
  // workingRevision's `SELECT … FOR UPDATE` (part-process-steps.ts), which is the only raw query
  // in the app that can lose a serialization race.
  it("maps a raw query's serialization failure to 409, same as P2034", async () => {
    const rawConflict = Object.assign(
      new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40001`.", {
        code: "P2010", clientVersion: "test",
        meta: {
          driverAdapterError: {
            name: "DriverAdapterError",
            cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
          },
        },
      }), {});

    expect(() => translatePrisma(rawConflict, { entity: "Process step" }))
      .toThrow(expect.objectContaining({ status: 409 }));
  });

  // #90: a deadlock victim (SQLSTATE 40P01) is the same condition one notch over — the transaction
  // was aborted, nothing was written, and a re-run is safe — so it gets the same 409 instead of
  // escaping as a 500. Raw queries wrap it as P2010 exactly like 40001.
  it("maps a raw query's deadlock failure (40P01) to 409, same as a serialization failure", async () => {
    const rawDeadlock = new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40P01`.", {
      code: "P2010", clientVersion: "test",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { originalCode: "40P01", kind: "TransactionWriteConflict" },
        },
      },
    });
    expect(() => translatePrisma(rawDeadlock, { entity: "Shipment" }))
      .toThrow(expect.objectContaining({ status: 409 }));
  });

  it("leaves a raw query failure that is not a serialization conflict alone", async () => {
    const otherRaw = new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `42703`.", {
      code: "P2010", clientVersion: "test",
      meta: { driverAdapterError: { cause: { originalCode: "42703" } } },
    });
    expect(() => translatePrisma(otherRaw, { entity: "Process step" })).toThrow(otherRaw);
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

// #90: the retry wrapper's scope. A P2002 is only a losing-Serializable-writer shape at ONE call
// site (closePeriod's year-month insert race); the allocation paths answer nonce P2002s by
// in-attempt replay and never retry (#115), and constraint-name discrimination via `meta.target`
// is unavailable on the driver-adapter stack (#40) — so the unique-conflict retry is a per-call
// opt-in boolean, default off. Deadlock victims (40P01) join 40001 as always-retryable.
describe("retryOnSerializationConflict scope (#90)", () => {
  const p2002 = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002", clientVersion: "test", meta: { target: ["year", "month"] },
  });
  const rawDeadlock = () => new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40P01`.", {
    code: "P2010", clientVersion: "test",
    meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
  });

  it("throws a P2002 on attempt 1 through the DEFAULT path — the unique retry is opt-in", async () => {
    let calls = 0;
    await expect(retryOnSerializationConflict(async () => { calls += 1; throw p2002(); }, 5))
      .rejects.toMatchObject({ code: "P2002" });
    expect(calls).toBe(1);
  });

  it("retries a P2002 up to `tries` through the opt-in path (closePeriod's year-month race)", async () => {
    let calls = 0;
    await expect(retryOnSerializationConflict(
      async () => { calls += 1; throw p2002(); }, 3, { retryUniqueConflict: true },
    )).rejects.toMatchObject({ code: "P2002" });
    expect(calls).toBe(3);
  });

  it("absorbs a raw deadlock victim (40P01) when the re-run succeeds", async () => {
    let calls = 0;
    const result = await retryOnSerializationConflict(async () => {
      calls += 1;
      if (calls === 1) throw rawDeadlock();
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});
