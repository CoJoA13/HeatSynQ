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

// #40: on the Prisma 7 + @prisma/adapter-pg stack a P2002 carries NO `meta.target` and a P2003
// carries NO `meta.constraint` — the answer lives in `meta.driverAdapterError.cause.constraint`
// ({ fields } for 23505, { index } for 23503), with mixed-case identifiers arriving wrapped in
// literal double quotes (parsed from Postgres' DETAIL line). These tests pin the extraction:
// three through the real DB (the measured shapes), two synthetic (legacy-first ordering and the
// never-throws fallback). The legacy `meta.target` synthetic in the #90 describe below stays as
// the legacy-shape regression alongside these.
describe("P2002/P2003 field extraction on the driver-adapter stack (#40)", () => {
  beforeEach(async () => await truncateAll());

  it("names the conflicting field on a real P2002 without conflictField (Role.name)", async () => {
    await prisma.role.create({ data: { name: "Office" } });
    const boom = withDbErrors({ entity: "Role" }, () =>
      prisma.role.create({ data: { name: "Office" } }));
    await expect(boom).rejects.toMatchObject({
      status: 400, message: "A role with that name already exists",
    });
  });

  // Mixed-case identifiers arrive from the adapter as '"tokenHash"' — literal embedded double
  // quotes, parsed straight out of Postgres' DETAIL line. The extractor must strip them or the
  // user sees `that "tokenHash"`.
  it("strips the adapter's embedded quotes on a camelCase P2002 (Session.tokenHash)", async () => {
    const user = await prisma.user.create({
      data: { username: "u1", passwordHash: "x", displayName: "U One" },
    });
    const expiresAt = new Date(Date.now() + 3_600_000);
    await prisma.session.create({ data: { tokenHash: "tok-1", userId: user.id, expiresAt } });
    const boom = withDbErrors({ entity: "Session" }, () =>
      prisma.session.create({ data: { tokenHash: "tok-1", userId: user.id, expiresAt } }));
    await expect(boom).rejects.toMatchObject({ status: 400 });
    const message = await boom.catch((e: HttpError) => e.message);
    expect(message).toContain("tokenHash");
    expect(message).not.toContain('"');
  });

  // Calls the delegate directly: the service path (`createReference` → `assertRefExists`)
  // pre-checks the FK and would 400 before the constraint ever fires. The constraint is the
  // race-path backstop, and its message should name the field just like the pre-check does.
  it("names the missing reference on a real P2003 (PaymentType.glAccountId)", async () => {
    const boom = withDbErrors({ entity: "Payment type" }, () =>
      prisma.paymentType.create({ data: { name: "Check", glAccountId: "nope" } }));
    await expect(boom).rejects.toMatchObject({
      status: 400, message: "That gl account does not exist",
    });
  });

  // Legacy-first ordering (the isDuplicateClientRequestId precedent, orders.ts): `meta.target` /
  // `meta.constraint` are consulted BEFORE the adapter shape, so a future adapter that populates
  // them wins even when the driver-adapter cause disagrees.
  it("prefers the legacy meta shapes over the adapter shape (synthetic)", () => {
    const legacyP2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test",
      meta: {
        target: ["name"],
        driverAdapterError: { cause: { constraint: { fields: ['"somethingElse"'] } } },
      },
    });
    expect(() => translatePrisma(legacyP2002, { entity: "Role" }))
      .toThrow(expect.objectContaining({ status: 400, message: "A role with that name already exists" }));

    const legacyStringTarget = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test", meta: { target: "name" },
    });
    expect(() => translatePrisma(legacyStringTarget, { entity: "Role" }))
      .toThrow(expect.objectContaining({ status: 400, message: "A role with that name already exists" }));

    const legacyP2003 = new Prisma.PrismaClientKnownRequestError("FK constraint failed", {
      code: "P2003", clientVersion: "test",
      meta: {
        constraint: "PaymentType_glAccountId_fkey", modelName: "PaymentType",
        driverAdapterError: { cause: { constraint: { index: "PaymentType_nopeId_fkey" } } },
      },
    });
    expect(() => translatePrisma(legacyP2003, { entity: "Payment type" }))
      .toThrow(expect.objectContaining({ status: 400, message: "That gl account does not exist" }));
  });

  // The adapter omits `constraint` entirely when Postgres sends no DETAIL line — the extractor
  // must fall back to "value", never throw.
  it("falls back to 'value' on a P2002 with neither shape (synthetic)", () => {
    const bare = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test", meta: { modelName: "Role" },
    });
    expect(() => translatePrisma(bare, { entity: "Role" }))
      .toThrow(expect.objectContaining({ status: 400, message: "A role with that value already exists" }));

    const noDetail = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test",
      meta: { modelName: "Role", driverAdapterError: { cause: { originalCode: "23505" } } },
    });
    expect(() => translatePrisma(noDetail, { entity: "Role" }))
      .toThrow(expect.objectContaining({ status: 400, message: "A role with that value already exists" }));
  });
});

// #90: the retry wrapper's scope. A P2002 is only a losing-Serializable-writer shape at ONE call
// site (closePeriod's year-month insert race); the allocation paths answer nonce P2002s by
// in-attempt replay and never retry (#115). Constraint discrimination IS possible since #40
// (`uniqueConflictFields` reads the adapter shape), but whether a P2002 means "a concurrent
// writer won — a re-run will see its row" is a fact about the call site's own insert semantics,
// not about which constraint fired — so the unique-conflict retry stays a per-call opt-in
// boolean, default off. Deadlock victims (40P01) join 40001 as always-retryable.
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
