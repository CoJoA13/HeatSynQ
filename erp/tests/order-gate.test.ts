import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { createOrder } from "@/server/orders";
import { setSetting } from "@/server/settings";
import { HttpError } from "@/server/errors";
import { runWithContext } from "@/server/context";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// A shape-valid input (passes CREATE.parse) whose customer/part do not exist. The gate is evaluated
// BEFORE the transaction that resolves the customer, so when it blocks we never reach the customer
// lookup, and when it passes we fail there instead — which is exactly how we tell the two apart.
const input = { customerId: "no-such-customer", lines: [{ partId: "no-such-part", qty: 1, weight: "1.00" }] };

async function caught(fn: () => Promise<unknown>): Promise<HttpError> {
  return (await fn().then(() => { throw new Error("expected a throw"); }, (e) => e)) as HttpError;
}

describe("order-entry gate at createOrder (Phase 8B §5.6)", () => {
  beforeEach(truncateAll);

  it("blocks order entry (400) when company identity AND chart of accounts are unset", async () => {
    const err = await caught(() => asSystem(() => createOrder(input)));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Finish setup/);
  });

  it("still blocks when only company identity is set (chart of accounts missing)", async () => {
    await asSystem(async () => {
      await setSetting("company_name", "X");
      await setSetting("company_address", "Y");
      await setSetting("company_phone", "Z");
    });
    const err = await caught(() => asSystem(() => createOrder(input)));
    expect(err.message).toMatch(/Finish setup/);
  });

  it("passes the gate once company identity + chart of accounts are seeded", async () => {
    await seedOrderGatePrereqs();
    // The gate no longer blocks: execution proceeds into the save and fails on the missing customer,
    // so the error is NOT the gate error — proof the gate let it through.
    const err = await caught(() => asSystem(() => createOrder(input)));
    expect(err.message).not.toMatch(/Finish setup/);
  });
});
