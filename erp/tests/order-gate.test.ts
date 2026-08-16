import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
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

  it("returns the existing order for a retried nonce even after setup becomes incomplete", async () => {
    // Idempotency (Codex): a delayed retry of an already-committed order must get its order back,
    // not a setup-400, if an admin has since cleared a company field.
    await seedOrderGatePrereqs();
    const customer = await prisma.customer.create({ data: { code: "IDEM", name: "Idem Co" } });
    const code = await prisma.processStepCode.create({ data: { code: "HT", name: "Harden" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "IP1", name: "Idem Part", eachWeight: "1.0000" },
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Harden." },
    });

    const nonce = crypto.randomUUID();
    const req = { customerId: customer.id, clientRequestId: nonce, lines: [{ partId: part.id, qty: 1, weight: "1.00" }] };
    const first = await asSystem(() => createOrder(req));
    expect(first.order.orderNumber).toBeGreaterThan(0);

    // Setup becomes incomplete AFTER the order committed.
    await asSystem(() => setSetting("company_name", ""));

    // The retry carrying the same nonce returns the EXISTING order, never the gate 400.
    const retried = await asSystem(() => createOrder(req));
    expect(retried.deduped).toBe(true);
    expect(retried.order.orderNumber).toBe(first.order.orderNumber);
  });
});
