import { describe, it, expect } from "vitest";
import {
  DEV_DB_NAME, dbNameFromUrl, devDbRefusal, hostFromUrl, isLocalDbHost,
} from "../src/lib/dev-db-guard";

/**
 * The shared "is this the local dev database?" guard (#167a fix round). It stands in front of four
 * scripts, two of which truncate or hard-delete, and it was four hand copies until this file — one
 * of which had already drifted (`e2e/lib/manual-ids.ts` had lost `[::1]`). It is a pure function,
 * so there is no excuse for it not being pinned.
 *
 * The dangerous direction is the one that PASSES: the whole point of the guard is the production
 * compose profile's `postgresql://erp:…@db:5432/erp`, which carries the very same database name.
 */
describe("devDbRefusal", () => {
  const dev = { subject: "db:reset", consequence: "this deletes every row", dbName: "erp", host: "localhost" };

  it("passes the local dev database", () => {
    expect(devDbRefusal(dev)).toBeNull();
  });

  it("passes every spelling of this machine, including the bracketed IPv6 form `new URL` produces", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
      expect(devDbRefusal({ ...dev, host })).toBeNull();
    }
  });

  it("refuses the production compose URL, whose database name is `erp` too", () => {
    // The reason the host is the discriminator and the name is not. This is the case the guard exists for.
    const refusal = devDbRefusal({ ...dev, host: "db" });
    expect(refusal).toContain('got "erp" on "db"');
    expect(refusal).toContain("the name on its own proves nothing");
  });

  it("refuses the test and practice databases by construction", () => {
    expect(devDbRefusal({ ...dev, dbName: "erp_test" })).toContain('got "erp_test"');
    expect(devDbRefusal({ ...dev, dbName: "erp_practice" })).toContain('got "erp_practice"');
  });

  it("refuses a remote host even when the name is right", () => {
    expect(devDbRefusal({ ...dev, host: "10.0.0.7" })).not.toBeNull();
    expect(devDbRefusal({ ...dev, host: "db.internal.example.com" })).not.toBeNull();
  });

  it("names the caller and what it was about to do, so the message explains the refusal", () => {
    const refusal = devDbRefusal({
      subject: "The manual dataset", consequence: "this script creates dozens of orders",
      dbName: "erp", host: "db",
    });
    expect(refusal).toMatch(/^The manual dataset only ever runs against the LOCAL dev database/);
    expect(refusal).toContain("this script creates dozens of orders");
  });

  it("has no override flag or escape hatch in its signature at all", () => {
    // Stated as a test because it is a decision, not an omission: an override on a destructive
    // guard is the kind of thing that gets set once and never unset.
    expect(Object.keys(dev).sort()).toEqual(["consequence", "dbName", "host", "subject"]);
  });
});

describe("dbNameFromUrl / hostFromUrl / isLocalDbHost", () => {
  it("reads the database name and host out of a connection string", () => {
    const url = "postgresql://erp:erp_local_dev@localhost:5432/erp";
    expect(dbNameFromUrl(url)).toBe("erp");
    expect(hostFromUrl(url)).toBe("localhost");
  });

  it("is not fooled by a query string or a missing port", () => {
    expect(dbNameFromUrl("postgresql://u:p@127.0.0.1/erp_test?schema=public")).toBe("erp_test");
    expect(hostFromUrl("postgresql://u:p@127.0.0.1/erp_test?schema=public")).toBe("127.0.0.1");
  });

  it("normalises an IPv6 literal the way `new URL` does, which is why both forms are accepted", () => {
    expect(hostFromUrl("postgresql://u:p@[::1]:5432/erp")).toBe("[::1]");
    expect(isLocalDbHost("[::1]")).toBe(true);
    expect(isLocalDbHost("::1")).toBe(true);
    expect(isLocalDbHost("db")).toBe(false);
  });

  it("agrees with the constant the callers print", () => {
    expect(DEV_DB_NAME).toBe("erp");
  });
});
