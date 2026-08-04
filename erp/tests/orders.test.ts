import { describe, it, expect, beforeEach } from "vitest";
import { ZodError } from "zod";
import ExcelJS from "exceljs";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { HttpError } from "@/server/http";
import {
  createOrder, getOrder, listOrders, exportOrders,
  updateOrder, addLine, updateLine, removeLine,
  replaceContainers, replaceSerials, replaceCharges,
  voidOrder, linkOrder, unlinkOrder, getLockedRevision,
} from "@/server/orders";
import { updateStep, getRevision, getRevisions } from "@/server/part-process-steps";
import { setSetting } from "@/server/settings";
import { readAudit } from "@/server/audit";
import { deleteReference } from "@/server/reference";
import { deletePart } from "@/server/parts";
import { addBusinessDays, formatDateOnly, parseDateOnly, todayDateOnly } from "@/lib/business-days";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const asUser = <T>(id: string, fn: () => Promise<T>) =>
  runWithContext({ actor: { id, name: "Op One" }, user: null }, fn);

/** `today + n` calendar days as "yyyy-mm-dd" — the light is measured in calendar days, and
 *  every light assertion has to move with the clock rather than pin a date the suite outlives. */
const dayFromToday = (n: number) =>
  formatDateOnly(new Date(todayDateOnly().getTime() + n * 24 * 60 * 60 * 1000));

/**
 * Gives a part revision 1 with one step — the orderability precondition (spec §5.3). Built with
 * raw prisma on purpose: the orders service under test must not depend on the process-steps
 * service to construct its own fixtures (the part-process-steps.test.ts precedent).
 */
async function giveSteps(partId: string, codeId: string, revisionNumber = 1) {
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId, instruction: "Austenitize at 1650F." },
  });
  return rev;
}

/**
 * ACME with a lead part (3541720C3, loadQty 336) and a sibling rider (3541720C4). Only the lead
 * carries a step-bearing revision — riders are deliberately exempt from the orderability check
 * (spec §12.4), and leaving the rider without one keeps that exemption under test on every
 * happy-path save rather than in a single dedicated case.
 */
async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "ACME", name: "Acme Gear" } });
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  const lead = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "3541720C3", name: "Ring gear",
      eachWeight: "13.5000", loadQty: 336 },
  });
  const rider = await prisma.part.create({
    data: { customerId: customer.id, partNumber: "3541720C4", name: "Ring gear B", eachWeight: "13.5000" },
  });
  const leadRev = await giveSteps(lead.id, code.id);
  const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
  return { customer, code, lead, rider, leadRev, containerType };
}

/** The mockup order (spec §12.2): two sibling lines totalling 4,500 pcs / 60,750 lb. */
const mockupLines = (leadId: string, riderId: string) => [
  { partId: leadId, qty: 3000, weight: "40500.00" },
  { partId: riderId, qty: 1500, weight: "20250.00" },
];

/**
 * Fires every input without awaiting between starts, then retries whichever lost the race.
 *
 * The retry is not slack in the test — it is the documented contract. The order save runs
 * Serializable (required by the registered-FK writer pattern for `containers[].typeId`), and
 * `allocateNumber`'s `SELECT … FOR UPDATE` is a write-write conflict: under Read Committed
 * Postgres blocks and re-reads, but under Serializable it refuses with 40001, which
 * `withDbErrors` maps to the retryable 409 (global constraints: "serialization failures already
 * map to 409"). So a loser is EXPECTED — and this helper asserts the loser fails with exactly
 * that 409 and nothing else. What must never happen is two saves sharing a number, a number
 * being skipped, or a partial order surviving the abort.
 */
async function createConcurrently(inputs: unknown[]): Promise<number[]> {
  const settled = await Promise.allSettled(inputs.map((i) => asSystem(() => createOrder(i))));
  const numbers: number[] = [];
  for (const [i, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      numbers.push(result.value.order.orderNumber);
      continue;
    }
    expect(result.reason).toMatchObject({ status: 409 });
    const retried = await asSystem(() => createOrder(inputs[i]));
    numbers.push(retried.order.orderNumber);
  }
  return numbers;
}

describe("createOrder: the two-line sibling order", () => {
  beforeEach(truncateAll);

  it("locks the lead part's current revision onto line 1 and leaves riders null", async () => {
    const { customer, lead, rider, leadRev } = await fixture();

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "PO-8891", vsOrderNumber: "VS-4410",
      lines: mockupLines(lead.id, rider.id),
    }));

    expect(order.orderNumber).toBe(1000);
    expect(order.poNumber).toBe("PO-8891");
    expect(order.vsOrderNumber).toBe("VS-4410");
    expect(order.status).toBe("OPEN");
    expect(order.voided).toBe(false);

    expect(order.lines).toHaveLength(2);
    expect(order.lines[0]).toMatchObject({ position: 1, partId: lead.id, revisionNumber: 1, qty: 3000 });
    expect(order.lines[0].weight).toBe(40500);
    expect(order.lines[0].part).toMatchObject({
      id: lead.id, partNumber: "3541720C3", name: "Ring gear", customer: { code: "ACME" },
    });
    expect(order.lines[1]).toMatchObject({ position: 2, partId: rider.id, revisionNumber: null, qty: 1500 });

    // The lock is the point: the revision the order quotes is now frozen.
    const locked = await prisma.partProcessRevision.findFirstOrThrow({ where: { id: leadRev.id } });
    expect(locked.lockedAt).not.toBeNull();
  });

  // Fix-wave R3 finding 6: a user with orders.view but not parts.view gets no serialization
  // warning on the hub, because SerialsSection.tsx used to derive `serializationRequired` from a
  // separate parts-catalog fetch it never even attempts without that permission. The line itself
  // already carries the flag independent of any catalog grant — this pins that OrderDetail's own
  // line/part payload exposes it, both from createOrder's own response and from getOrder's
  // separate read (the hub's actual fetch), so SerialsSection can read it straight off the line.
  it("exposes each line's serializationRequired flag on its part, independent of a parts.view fetch", async () => {
    const { customer, lead, rider } = await fixture();
    await prisma.part.update({ where: { id: rider.id }, data: { serializationRequired: true } });

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: mockupLines(lead.id, rider.id),
    }));
    expect(order.lines[0].part.serializationRequired).toBe(false);
    expect(order.lines[1].part.serializationRequired).toBe(true);

    // getOrder is the hub's own independent read (GET /api/orders/[id]) — the flag must survive
    // that round trip too, not just createOrder's own response.
    const fetched = await getOrder(order.id);
    expect(fetched.lines[0].part.serializationRequired).toBe(false);
    expect(fetched.lines[1].part.serializationRequired).toBe(true);
  });

  it("auto-splits the mockup order into 14 loads whose weights sum exactly", async () => {
    const { customer, lead, rider } = await fixture();

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: mockupLines(lead.id, rider.id),
    }));

    // 4,500 pcs under the lead's 336/load cap: 13 full loads + a 132-piece remainder.
    expect(order.loads).toHaveLength(14);
    expect(order.loads.map((l) => l.loadNumber)).toEqual([...Array(14)].map((_, i) => i + 1));
    expect(order.loads.slice(0, 13).every((l) => l.qty === 336)).toBe(true);
    expect(order.loads[13].qty).toBe(132);
    expect(order.loads[0].weight).toBe(4536);
    expect(order.loads[13].weight).toBe(1782);

    // Exact to the cent — the last load absorbs the rounding (load-split.ts's contract).
    expect(order.loads.reduce((s, l) => s + Math.round((l.weight ?? 0) * 100), 0)).toBe(6_075_000);
    expect(order.loads.reduce((s, l) => s + (l.qty ?? 0), 0)).toBe(4500);
  });

  it("passes the lead part's weight cap through as a number, not a Decimal", async () => {
    const { customer, code } = await fixture();
    // Weight-only cap: 1,000 lb per load over an order averaging 10 lb/pc → 100 pcs per load.
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "W-1", eachWeight: "10.0000", loadWeight: "1000.00" },
    });
    await giveSteps(part.id, code.id);

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: part.id, qty: 250, weight: "2500.00" }],
    }));

    expect(order.loads.map((l) => l.qty)).toEqual([100, 100, 50]);
    expect(order.loads.reduce((s, l) => s + (l.weight ?? 0), 0)).toBe(2500);
  });

  it("puts the totals in a single load when the lead part carries no caps", async () => {
    const { customer, rider } = await fixture();
    const code = await prisma.processStepCode.findFirstOrThrow({ where: { code: "HT-01" } });
    await giveSteps(rider.id, code.id); // the rider has no loadQty/loadWeight

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: rider.id, qty: 40, weight: "540.00" }],
    }));

    expect(order.loads).toHaveLength(1);
    expect(order.loads[0]).toMatchObject({ loadNumber: 1, qty: 40, weight: 540 });
  });

  // Fix-wave R2 finding 3: nothing used to stop a huge qty under a tiny loadQty cap from
  // synchronously allocating one Load row per piece — createOrder must surface load-split's own
  // refusal as a clean 400, not let it (or a resulting 500) leak through, and nothing should be
  // written when it does.
  it("maps a split that would exceed 10,000 loads to a clean 400 naming the count, and writes nothing", async () => {
    const { customer, code } = await fixture();
    const tinyCapPart = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "TINY-1", name: "Tiny-cap part", eachWeight: "1.0000", loadQty: 1 },
    });
    await giveSteps(tinyCapPart.id, code.id);

    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: tinyCapPart.id, qty: 10_001, weight: "10001.00" }],
    }))).rejects.toMatchObject({
      status: 400,
      message: "This split would produce 10001 loads (max 10,000) — check the part's load quantity",
    });
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects a line qty above 10,000,000 — the zod cap, independent of and ahead of the load-count check", async () => {
    const { customer, lead } = await fixture();
    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 10_000_001, weight: "1.00" }],
    }))).rejects.toBeInstanceOf(ZodError);
    expect(await prisma.order.count()).toBe(0);
  });

  it("stores containers and charges in payload order with 1-based positions", async () => {
    const { customer, lead, containerType } = await fixture();
    const crate = await prisma.containerType.create({ data: { name: "Crate" } });

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 10, weight: "135.00" }],
      containers: [
        { typeId: containerType.id, count: 3, qty: 100, tareWeight: "42.50", grossWeight: "980.00" },
        { typeId: crate.id, count: 1 },
      ],
      charges: [
        { description: "Freight", amount: "125.00" },
        { description: "Straightening", amount: null },
      ],
    }));

    expect(order.containers).toHaveLength(2);
    expect(order.containers[0]).toMatchObject({
      position: 1, typeId: containerType.id, count: 3, qty: 100,
      tareWeight: 42.5, grossWeight: 980, type: { name: "Basket" },
    });
    expect(order.containers[1]).toMatchObject({
      position: 2, count: 1, qty: null, tareWeight: null, grossWeight: null, type: { name: "Crate" },
    });

    expect(order.charges).toEqual([
      expect.objectContaining({ position: 1, description: "Freight", amount: 125 }),
      expect.objectContaining({ position: 2, description: "Straightening", amount: null }),
    ]);
  });

  it("rejects unknown keys — the shape is .strict() end to end", async () => {
    const { customer, lead } = await fixture();
    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "1.00" }], bogus: 1,
    }))).rejects.toThrow();
    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "1.00", bogus: 1 }],
    }))).rejects.toThrow();
    expect(await prisma.order.count()).toBe(0);
  });
});

describe("createOrder: numbering", () => {
  beforeEach(truncateAll);

  it("two concurrent saves get distinct, consecutive numbers and never share one", async () => {
    const { customer, lead } = await fixture();
    const input = { customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }] };

    const numbers = await createConcurrently([input, input]);

    expect(new Set(numbers).size).toBe(2);
    expect([...numbers].sort((a, b) => a - b)).toEqual([1000, 1001]);
    expect(await prisma.order.count()).toBe(2);
    const stored = await prisma.order.findMany({ select: { orderNumber: true }, orderBy: { orderNumber: "asc" } });
    expect(stored.map((o) => o.orderNumber)).toEqual([1000, 1001]);
  });

  it("continues from the configured seed", async () => {
    const { customer, lead } = await fixture();
    await asSystem(() => setSetting("order_number_next", 5200));

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));

    expect(order.orderNumber).toBe(5200);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: "order_number_next" } })).value).toBe(5201);
  });

  it("consumes no number when the save fails — the whole transaction rolls back", async () => {
    const { customer, lead, rider } = await fixture(); // the rider has no process steps

    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: rider.id, qty: 1, weight: "13.50" }],
    }))).rejects.toMatchObject({ status: 400 });

    expect(await prisma.order.count()).toBe(0);
    // allocateNumber upserts the Setting row before claiming it; that upsert rolls back too.
    expect(await prisma.setting.findUnique({ where: { key: "order_number_next" } })).toBeNull();

    // The next good save still gets the first number — nothing was burned.
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    expect(order.orderNumber).toBe(1000);
  });
});

/**
 * Fix-wave R4 finding 5 — the double-create this project exists to prevent.
 *
 * Two tabs resume the SAME autosaved draft; both Save. The save runs Serializable and
 * `allocateNumber` is a write-write conflict, so the loser aborts with 40001 -> the retryable 409
 * — and the entry page retries it automatically, because the documented contract is that a 409
 * wrote nothing and consumed no number. That retry is a FRESH request: before this fix it created
 * a SECOND order carrying the next number, for the one job the operator did once. `orderNumber`
 * being unique never helped — the retry legitimately allocates its own.
 *
 * `clientRequestId` is what makes the two submissions recognizable as one intent: the nonce is
 * minted when a fresh entry form mounts and lives INSIDE the draft payload, so two tabs resuming
 * the same draft carry the same one.
 */
describe("createOrder: clientRequestId idempotency", () => {
  beforeEach(truncateAll);

  const NONCE = "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e";

  it("the same clientRequestId twice creates ONE order — the second call returns the first", async () => {
    const { customer, lead } = await fixture();
    const input = {
      customerId: customer.id, clientRequestId: NONCE,
      lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    };

    const first = await asSystem(() => createOrder(input));
    const second = await asSystem(() => createOrder(input));

    expect(second.order.id).toBe(first.order.id);
    expect(second.order.orderNumber).toBe(first.order.orderNumber);
    // The client has to be able to tell a replay from a fresh save — this is that signal.
    expect(second.deduped).toBe(true);
    expect(second.warnings).toEqual([]);
    // The first save is the only one that was ever a save: one order, one number consumed.
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: "order_number_next" } })).value).toBe(1001);
  });

  it("a fresh save carries no `deduped` flag — the response shape is unchanged for every old caller", async () => {
    const { customer, lead } = await fixture();
    const result = await asSystem(() => createOrder({
      customerId: customer.id, clientRequestId: NONCE,
      lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    expect(result.deduped).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(["order", "warnings"]);
  });

  it("different clientRequestIds are different intents — two orders, two numbers", async () => {
    const { customer, lead } = await fixture();
    const base = { customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }] };

    const a = await asSystem(() => createOrder({ ...base, clientRequestId: NONCE }));
    const b = await asSystem(() => createOrder({
      ...base, clientRequestId: "aaaaaaaa-2222-4d22-8e33-9f0a1b2c3d4e",
    }));

    expect(b.order.id).not.toBe(a.order.id);
    expect([a.order.orderNumber, b.order.orderNumber]).toEqual([1000, 1001]);
    expect(await prisma.order.count()).toBe(2);
  });

  it("omitting clientRequestId keeps the old behaviour exactly — nothing dedupes", async () => {
    const { customer, lead } = await fixture();
    const input = { customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }] };

    const a = await asSystem(() => createOrder(input));
    const b = await asSystem(() => createOrder(input));

    expect(b.order.id).not.toBe(a.order.id);
    expect(await prisma.order.count()).toBe(2);
    // NULLs never collide in a Postgres unique index — that is what makes the opt-out free.
    expect(await prisma.order.count({ where: { clientRequestId: null } })).toBe(2);
  });

  // The real shape: two tabs firing at once, then the loser's automatic 409 retry — exactly what
  // src/app/orders/new/page.tsx's handleSave does, with the SAME body (nonce included) it built
  // once before the first attempt.
  it("two concurrent saves of the same intent settle on exactly ONE order, retry included", async () => {
    const { customer, lead } = await fixture();
    const input = {
      customerId: customer.id, clientRequestId: NONCE,
      lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    };

    const settled = await Promise.allSettled([
      asSystem(() => createOrder(input)), asSystem(() => createOrder(input)),
    ]);

    const ids = new Set<string>();
    for (const result of settled) {
      if (result.status === "fulfilled") { ids.add(result.value.order.id); continue; }
      // A Serializable loser is told to retry — the only acceptable failure here, and the very
      // thing that used to double-create.
      expect(result.reason).toMatchObject({ status: 409 });
      const retried = await asSystem(() => createOrder(input));
      ids.add(retried.order.id);
    }

    expect(ids.size).toBe(1);
    expect(await prisma.order.count()).toBe(1);
  });

  it("rejects a clientRequestId that is not a uuid", async () => {
    const { customer, lead } = await fixture();
    await expect(asSystem(() => createOrder({
      customerId: customer.id, clientRequestId: "not-a-uuid",
      lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }))).rejects.toBeInstanceOf(ZodError);
  });

  // A voided order keeps its request id forever, exactly as it keeps its number (spec §4). A
  // replay of the request that created it therefore still resolves to it — never to a brand-new
  // order re-using the nonce, which is the revival-on-create shape handoff §5.18 rules out.
  it("a voided order still owns its request id — a replay returns the voided order, not a new one", async () => {
    const { customer, lead } = await fixture();
    const input = {
      customerId: customer.id, clientRequestId: NONCE,
      lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    };
    const first = await asSystem(() => createOrder(input));
    await asSystem(() => voidOrder(first.order.id, "wrong customer"));

    const replay = await asSystem(() => createOrder(input));
    expect(replay.order.id).toBe(first.order.id);
    expect(replay.order.voided).toBe(true);
    expect(replay.deduped).toBe(true);
    expect(await prisma.order.count()).toBe(1);
  });
});

describe("createOrder: dates", () => {
  beforeEach(truncateAll);

  it("defaults receivedDate to today", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    expect(order.receivedDate).toBe(formatDateOnly(todayDateOnly()));
  });

  // 2026-08-07 is a Friday; five business days later is Friday 2026-08-14 (the weekend does not
  // count). The chain is most-specific-wins and silent (spec §6).
  it("derives requestDate from the plant default when neither override is set", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, receivedDate: "2026-08-07",
      lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    expect(order.requestDate).toBe("2026-08-14"); // plant default 5, Friday → Friday
    expect(order.requestDate).toBe(formatDateOnly(addBusinessDays(parseDateOnly("2026-08-07"), 5)));
  });

  it("lets the customer override beat the plant default", async () => {
    const { customer, lead } = await fixture();
    await prisma.customer.update({ where: { id: customer.id }, data: { requestDaysOverride: 7 } });

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, receivedDate: "2026-08-07",
      lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    expect(order.requestDate).toBe(formatDateOnly(addBusinessDays(parseDateOnly("2026-08-07"), 7)));
  });

  it("lets the LEAD part's override beat both", async () => {
    const { customer, lead, rider } = await fixture();
    await prisma.customer.update({ where: { id: customer.id }, data: { requestDaysOverride: 7 } });
    await prisma.part.update({ where: { id: lead.id }, data: { requestDaysOverride: 3 } });
    // A rider override must NOT participate — only the lead's counts.
    await prisma.part.update({ where: { id: rider.id }, data: { requestDaysOverride: 20 } });

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, receivedDate: "2026-08-07",
      lines: mockupLines(lead.id, rider.id),
    }));
    expect(order.requestDate).toBe(formatDateOnly(addBusinessDays(parseDateOnly("2026-08-07"), 3)));
  });

  it("honours explicit dates over every default, including a null target", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, receivedDate: "2026-08-07", requestDate: "2026-09-01",
      targetDate: "2026-09-03", lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    expect(order).toMatchObject({
      receivedDate: "2026-08-07", requestDate: "2026-09-01", targetDate: "2026-09-03",
    });

    const { order: noTarget } = await asSystem(() => createOrder({
      customerId: customer.id, targetDate: null,
      lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    expect(noTarget.targetDate).toBeNull();
  });

  it("rejects a malformed or non-existent date, naming the field", async () => {
    const { customer, lead } = await fixture();
    const lines = [{ partId: lead.id, qty: 1, weight: "13.50" }];

    await expect(asSystem(() => createOrder({ customerId: customer.id, receivedDate: "2026-02-30", lines })))
      .rejects.toMatchObject({
        status: 400, message: '"2026-02-30" is not a valid date (yyyy-mm-dd) for Received date',
      });
    await expect(asSystem(() => createOrder({ customerId: customer.id, requestDate: "08/07/2026", lines })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("Request date") });
    await expect(asSystem(() => createOrder({ customerId: customer.id, targetDate: "not-a-date", lines })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("Target date") });

    expect(await prisma.order.count()).toBe(0);
  });
});

describe("createOrder: rejections", () => {
  beforeEach(truncateAll);

  it("rejects an unknown or soft-deleted customer", async () => {
    const { customer, lead } = await fixture();
    const lines = [{ partId: lead.id, qty: 1, weight: "13.50" }];

    await expect(asSystem(() => createOrder({ customerId: "nope", lines })))
      .rejects.toMatchObject({ status: 400, message: "That customer does not exist" });

    await prisma.customer.update({ where: { id: customer.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => createOrder({ customerId: customer.id, lines })))
      .rejects.toMatchObject({ status: 400, message: "That customer does not exist" });
  });

  it("rejects an inactive customer", async () => {
    const { customer, lead } = await fixture();
    await prisma.customer.update({ where: { id: customer.id }, data: { active: false } });

    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }))).rejects.toMatchObject({ status: 400, message: "That customer is inactive" });
  });

  it("rejects a part belonging to ANOTHER customer, naming the line and the part", async () => {
    const { customer, lead, code } = await fixture();
    const other = await prisma.customer.create({ data: { code: "OTHR", name: "Other Co" } });
    const theirs = await prisma.part.create({
      data: { customerId: other.id, partNumber: "X-9", eachWeight: "1.0000" },
    });
    await giveSteps(theirs.id, code.id);

    await expect(asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 1, weight: "13.50" }, { partId: theirs.id, qty: 1, weight: "1.00" }],
    }))).rejects.toMatchObject({
      status: 400, message: "Line 2 (OTHR · X-9): that part belongs to another customer",
    });
  });

  it("rejects an inactive part, naming the line", async () => {
    const { customer, lead } = await fixture();
    await prisma.part.update({ where: { id: lead.id }, data: { active: false } });

    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }))).rejects.toMatchObject({
      status: 400, message: "Line 1 (ACME · 3541720C3): that part is inactive",
    });
  });

  it("rejects an unknown or soft-deleted part, naming the line", async () => {
    const { customer, lead } = await fixture();

    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: "nope", qty: 1, weight: "1.00" }],
    }))).rejects.toMatchObject({ status: 400, message: "Line 1: that part does not exist" });

    await prisma.part.update({ where: { id: lead.id }, data: { deletedAt: new Date() } });
    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }))).rejects.toMatchObject({ status: 400, message: "Line 1: that part does not exist" });
  });

  it("rejects a lead part with no process steps, and exempts riders from the same rule", async () => {
    const { customer, lead, rider } = await fixture();

    // Rider first: a rider with no revision at all rides along fine.
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: mockupLines(lead.id, rider.id),
    }));
    expect(order.lines[1].revisionNumber).toBeNull();

    // Lead second: the same part in position 1 is refused.
    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: rider.id, qty: 1, weight: "13.50" }],
    }))).rejects.toMatchObject({ status: 400, message: "This part has no process steps" });
  });

  it("rejects a lead part whose current revision has zero steps", async () => {
    const { customer } = await fixture();
    const bare = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "B-1", eachWeight: "1.0000" },
    });
    await prisma.partProcessRevision.create({ data: { partId: bare.id, revisionNumber: 1 } });

    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: bare.id, qty: 1, weight: "1.00" }],
    }))).rejects.toMatchObject({ status: 400, message: "This part has no process steps" });
  });

  it("rejects an unknown container type and writes nothing", async () => {
    const { customer, lead } = await fixture();

    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
      containers: [{ typeId: "nope", count: 1 }],
    }))).rejects.toMatchObject({ status: 400, message: "That container type does not exist" });

    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.orderContainer.count()).toBe(0);
  });

  it("rejects a soft-deleted container type", async () => {
    const { customer, lead, containerType } = await fixture();
    await prisma.containerType.update({ where: { id: containerType.id }, data: { deletedAt: new Date() } });

    await expect(asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
      containers: [{ typeId: containerType.id, count: 1 }],
    }))).rejects.toMatchObject({ status: 400, message: "That container type does not exist" });
  });

  // Fix-wave R3 finding 2: `count`/`qty` are destined for PostgreSQL `INTEGER` columns
  // (OrderContainer.count/qty, schema.prisma). A value above the Int4 range used to pass this
  // schema, reach the nested create, and fail with an unmapped database range error — a 500 —
  // instead of a field-anchored 400 like every other bad input on this endpoint. Both fields are
  // capped to the Int4 max, so the rejection happens at zod, before the transaction ever opens.
  it("rejects container count/qty above the Postgres Int4 range with a field-anchored 400, not a 500", async () => {
    const { customer, lead, containerType } = await fixture();
    const base = { customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }] };

    let overCount: unknown;
    try {
      await asSystem(() => createOrder({
        ...base, containers: [{ typeId: containerType.id, count: 2_147_483_648 }],
      }));
    } catch (e) { overCount = e; }
    expect(overCount).toBeInstanceOf(ZodError);
    expect((overCount as ZodError).issues[0].path).toEqual(["containers", 0, "count"]);

    let overQty: unknown;
    try {
      await asSystem(() => createOrder({
        ...base, containers: [{ typeId: containerType.id, count: 1, qty: 2_147_483_648 }],
      }));
    } catch (e) { overQty = e; }
    expect(overQty).toBeInstanceOf(ZodError);
    expect((overQty as ZodError).issues[0].path).toEqual(["containers", 0, "qty"]);

    expect(await prisma.order.count()).toBe(0);
  });
});

describe("createOrder: serials", () => {
  beforeEach(truncateAll);

  it("stores each line's serials against that line, numbered from 1", async () => {
    const { customer, lead, rider } = await fixture();

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [
        { partId: lead.id, qty: 2, weight: "27.00",
          serials: [{ serial: "EC001", description: "heat 44A" }, { serial: "EC002" }] },
        { partId: rider.id, qty: 1, weight: "13.50", serials: [{ serial: "EC003" }] },
      ],
    }));

    expect(order.serials).toHaveLength(3);
    expect(order.serials.map((s) => s.serial)).toEqual(["EC001", "EC002", "EC003"]);
    expect(order.serials[0]).toMatchObject({ lineId: order.lines[0].id, position: 1, description: "heat 44A" });
    expect(order.serials[1]).toMatchObject({ lineId: order.lines[0].id, position: 2, description: "" });
    expect(order.serials[2]).toMatchObject({ lineId: order.lines[1].id, position: 1 });
  });

  it("rejects a serial repeated within one line, naming the serial", async () => {
    const { customer, lead } = await fixture();

    await expect(asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 3, weight: "40.50",
        serials: [{ serial: "EC001" }, { serial: "EC002" }, { serial: "EC001" }] }],
    }))).rejects.toMatchObject({
      status: 400, message: 'Line 1 (ACME · 3541720C3): serial "EC001" is entered twice',
    });

    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.orderSerial.count()).toBe(0);
  });

  it("allows the same serial on two different lines", async () => {
    const { customer, lead, rider } = await fixture();

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [
        { partId: lead.id, qty: 1, weight: "13.50", serials: [{ serial: "EC001" }] },
        { partId: rider.id, qty: 1, weight: "13.50", serials: [{ serial: "EC001" }] },
      ],
    }));

    expect(order.serials).toHaveLength(2);
    expect(order.serials[0].lineId).not.toBe(order.serials[1].lineId);
  });
});

describe("createOrder: warnings", () => {
  beforeEach(truncateAll);

  it("warns per line when a serialization-required part carries no serials, and still saves", async () => {
    const { customer, lead, rider } = await fixture();
    await prisma.part.update({ where: { id: rider.id }, data: { serializationRequired: true } });

    const { order, warnings } = await asSystem(() => createOrder({
      customerId: customer.id, lines: mockupLines(lead.id, rider.id),
    }));

    expect(warnings).toEqual([
      "Line 2 (ACME · 3541720C4): serialization required but no serials entered",
    ]);
    expect(order.id).toBeTruthy();
    expect(await prisma.order.count()).toBe(1);
  });

  it("does not warn once that line has serials", async () => {
    const { customer, lead } = await fixture();
    await prisma.part.update({ where: { id: lead.id }, data: { serializationRequired: true } });

    const { warnings } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 1, weight: "13.50", serials: [{ serial: "EC001" }] }],
    }));
    expect(warnings).toEqual([]);
  });

  it("warns on credit hold without blocking the save", async () => {
    const { customer, lead } = await fixture();
    await prisma.customer.update({ where: { id: customer.id }, data: { creditHold: true } });

    const { order, warnings } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));

    expect(warnings).toEqual(["ACME · Acme Gear is on credit hold"]);
    expect(order.orderNumber).toBe(1000);
  });

  it("reports serialization lines before the credit-hold notice when both apply", async () => {
    const { customer, lead } = await fixture();
    await prisma.customer.update({ where: { id: customer.id }, data: { creditHold: true } });
    await prisma.part.update({ where: { id: lead.id }, data: { serializationRequired: true } });

    const { warnings } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));

    expect(warnings).toEqual([
      "Line 1 (ACME · 3541720C3): serialization required but no serials entered",
      "ACME · Acme Gear is on credit hold",
    ]);
  });
});

describe("createOrder: audit", () => {
  beforeEach(truncateAll);

  it("writes exactly one order create entry whose snapshot carries the ordered children", async () => {
    const { customer, lead, rider, containerType } = await fixture();

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "PO-8891", notes: "rush",
      receivedDate: "2026-08-07",
      lines: [
        { ...mockupLines(lead.id, rider.id)[0], serials: [{ serial: "EC002" }, { serial: "EC001" }] },
        mockupLines(lead.id, rider.id)[1],
      ],
      containers: [{ typeId: containerType.id, count: 3, tareWeight: "42.50" }],
      charges: [{ description: "Freight", amount: "125.00" }],
    }));

    const entries = await prisma.auditLog.findMany({ where: { entity: "order" } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "create", entityId: order.id, actorName: "test" });

    const after = entries[0].after as Record<string, unknown>;
    expect(after).toMatchObject({
      orderNumber: 1000, customerId: customer.id, customerCode: "ACME",
      poNumber: "PO-8891", notes: "rush", status: "OPEN",
      receivedDate: "2026-08-07", requestDate: "2026-08-14", targetDate: null,
    });

    // Children are ordered by construction — the issue-#24 lesson (an unordered collection makes
    // two otherwise-identical snapshots diff) applied to the create entry, not just to
    // SNAPSHOT_INCLUDE's update snapshots.
    const lines = after.lines as Record<string, unknown>[];
    expect(lines.map((l) => l.position)).toEqual([1, 2]);
    expect(lines[0]).toMatchObject({ partNumber: "3541720C3", revisionNumber: 1, qty: 3000, weight: 40500 });
    expect(lines[1]).toMatchObject({ partNumber: "3541720C4", revisionNumber: null });

    // Names, never cuids — the same rule SNAPSHOT_INCLUDE.order follows for update diffs.
    expect((after.containers as Record<string, unknown>[])[0])
      .toMatchObject({ position: 1, typeName: "Basket", count: 3, tareWeight: 42.5 });

    const loads = after.loads as Record<string, unknown>[];
    expect(loads).toHaveLength(14);
    expect(loads.map((l) => l.loadNumber)).toEqual([...Array(14)].map((_, i) => i + 1));

    // Serials keep the order they were keyed in (line position, then position within the line),
    // NOT alphabetical — "EC002" was entered first.
    expect(after.serials as Record<string, unknown>[]).toEqual([
      { linePosition: 1, position: 1, serial: "EC002", description: "" },
      { linePosition: 1, position: 2, serial: "EC001", description: "" },
    ]);

    expect((after.charges as Record<string, unknown>[])[0])
      .toMatchObject({ position: 1, description: "Freight", amount: 125 });
  });

  it("puts no fileData-shaped key anywhere in the create snapshot", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    await prisma.storedDocument.create({
      data: { orderId: order.id, kind: "TRAVELER", fileData: Buffer.from("pdf") },
    });

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entity: "order" } });
    expect(JSON.stringify(entry.after).toLowerCase()).not.toContain("filedata");
  });
});

describe("createOrder: draft", () => {
  beforeEach(truncateAll);

  it("clears the acting user's draft inside the same transaction", async () => {
    const { customer, lead } = await fixture();
    const user = await prisma.user.create({
      data: { username: "op1", passwordHash: "x", displayName: "Op One" },
    });
    const other = await prisma.user.create({
      data: { username: "op2", passwordHash: "x", displayName: "Op Two" },
    });
    await prisma.orderDraft.create({ data: { userId: user.id, payload: { customerId: customer.id } } });
    await prisma.orderDraft.create({ data: { userId: other.id, payload: { customerId: customer.id } } });

    await asUser(user.id, () => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));

    expect((await prisma.orderDraft.findFirstOrThrow({ where: { userId: user.id } })).payload).toBeNull();
    // Another user's draft is untouched — own-row only.
    expect((await prisma.orderDraft.findFirstOrThrow({ where: { userId: other.id } })).payload)
      .toEqual({ customerId: customer.id });
  });

  it("leaves the draft alone when the save fails", async () => {
    const { customer, rider } = await fixture();
    const user = await prisma.user.create({
      data: { username: "op1", passwordHash: "x", displayName: "Op One" },
    });
    await prisma.orderDraft.create({ data: { userId: user.id, payload: { customerId: customer.id } } });

    await expect(asUser(user.id, () => createOrder({
      customerId: customer.id, lines: [{ partId: rider.id, qty: 1, weight: "13.50" }],
    }))).rejects.toMatchObject({ status: 400 });

    expect((await prisma.orderDraft.findFirstOrThrow({ where: { userId: user.id } })).payload)
      .toEqual({ customerId: customer.id });
  });

  it("saves fine for an actor with no user row at all (system actor)", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    expect(order.orderNumber).toBe(1000);
  });
});

describe("createOrder + step edits: the locked revision (spec §12.3)", () => {
  beforeEach(truncateAll);

  it("a post-save step edit cuts revision N+1 and leaves the order's locked N byte-identical", async () => {
    const { customer, lead } = await fixture();
    const step = await prisma.partProcessStep.findFirstOrThrow({ where: { revision: { partId: lead.id } } });

    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    expect(order.lines[0].revisionNumber).toBe(1);
    const lockedBefore = await getRevision(lead.id, 1);
    expect(lockedBefore.lockedAt).not.toBeNull();

    const { revisionNumber } = await asSystem(() => updateStep(lead.id, step.id, { instruction: "Now 1700F." }));
    expect(revisionNumber).toBe(2);

    // The edit landed on rev 2; rev 1 — the one this order quotes — is untouched.
    expect(await getRevision(lead.id, 1)).toEqual(lockedBefore);
    expect((await getRevision(lead.id, 2)).steps[0].instruction).toBe("Now 1700F.");
    expect((await getOrder(order.id)).lines[0].revisionNumber).toBe(1);
  });

  // The 2C-3 race regression rerun against the REAL caller (spec §12.3). The deterministic,
  // signal-driven version already sits in part-process-steps.test.ts against `lockCurrentRevision`
  // itself; what this adds is the whole save transaction racing a step edit, interleaving left to
  // Postgres. Both outcomes are legitimate — the save locks what the editor had already committed,
  // or the editor blocks on the revision row and then cuts N+1 — so the assertion is the invariant
  // that survives either: an order never quotes a revision that can still be amended underneath it.
  //
  // Observed on this stack, the editor wins essentially every time: it reaches `workingRevision`'s
  // claim almost immediately while the save is still validating and allocating, so the save's
  // `SELECT … FOR UPDATE` finds a row updated after its own Serializable snapshot and gets 40001.
  // That is why the save is RETRIED here rather than skipped — retrying is the documented answer
  // to the 409, and skipping would leave every assertion below unreached.
  it("racing a step edit still leaves the order quoting a LOCKED, frozen revision", async () => {
    const { customer, lead } = await fixture();
    const step = await prisma.partProcessStep.findFirstOrThrow({ where: { revision: { partId: lead.id } } });
    const input = { customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }] };

    const savePromise = asSystem(() => createOrder(input));
    const editPromise = asSystem(() => updateStep(lead.id, step.id, { instruction: "after" }));
    const [save, edit] = await Promise.allSettled([savePromise, editPromise]);

    // A loser of the Serializable race is told to retry. Nothing else is an acceptable failure.
    for (const settled of [save, edit]) {
      if (settled.status === "rejected") expect(settled.reason).toMatchObject({ status: 409 });
    }
    const order = save.status === "fulfilled"
      ? save.value.order
      : (await asSystem(() => createOrder(input))).order;

    const quoted = order.lines[0].revisionNumber!;
    const frozen = await getRevision(lead.id, quoted);
    expect(frozen.lockedAt).not.toBeNull();
    // Whichever side got there first, the order quotes a real recipe — never a half-applied one.
    expect(["Austenitize at 1650F.", "after"]).toContain(frozen.steps[0].instruction);

    // And it stays frozen: editing the part again cannot reach back into the quoted revision.
    const current = (await getRevisions(lead.id))[0].revisionNumber; // getRevisions is desc
    const currentStep = (await getRevision(lead.id, current)).steps[0];
    await asSystem(() => updateStep(lead.id, currentStep.id, { instruction: "later still" }));
    expect(await getRevision(lead.id, quoted)).toEqual(frozen);
  });

  it("a second order quoting the same part re-locks the same revision without cutting a new one", async () => {
    const { customer, lead } = await fixture();
    const line = { partId: lead.id, qty: 1, weight: "13.50" };

    const first = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const second = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));

    expect(first.order.lines[0].revisionNumber).toBe(1);
    expect(second.order.lines[0].revisionNumber).toBe(1);
    expect(await prisma.partProcessRevision.count({ where: { partId: lead.id } })).toBe(1);
  });
});

describe("getOrder", () => {
  beforeEach(truncateAll);

  it("404s an unknown id", async () => {
    await expect(getOrder("nope")).rejects.toMatchObject({ status: 404, message: "Order not found" });
    await expect(getOrder("nope")).rejects.toBeInstanceOf(HttpError);
  });

  it("returns the whole graph with the lead line first and the light computed", async () => {
    const { customer, lead, rider } = await fixture();
    const created = await asSystem(() => createOrder({
      customerId: customer.id, requestDate: dayFromToday(1),
      lines: mockupLines(lead.id, rider.id),
    }));

    const detail = await getOrder(created.order.id);
    expect(detail.lines.map((l) => l.position)).toEqual([1, 2]);
    expect(detail.lines[0].partId).toBe(lead.id);
    expect(detail.loads).toHaveLength(14);
    expect(detail.light).toBe("will_miss"); // due tomorrow, will-miss window 3
    expect(detail.travelerPrinted).toBe(false);
    expect(detail.linkedOrders).toEqual([]);
  });

  it("reports travelerPrinted once any stored document exists", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));

    await prisma.storedDocument.create({
      data: { orderId: order.id, kind: "TRAVELER", fileData: Buffer.from("pdf") },
    });
    expect((await getOrder(order.id)).travelerPrinted).toBe(true);
  });

  it("returns a voided order — the hub renders it read-only rather than 404ing", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    await prisma.order.update({ where: { id: order.id }, data: { deletedAt: new Date() } });

    const detail = await getOrder(order.id);
    expect(detail.voided).toBe(true);
    expect(detail.orderNumber).toBe(1000);
  });

  it("lists the other orders in the link group, excluding itself", async () => {
    const { customer, lead } = await fixture();
    const line = { partId: lead.id, qty: 1, weight: "13.50" };
    const a = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const b = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const c = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    await prisma.order.updateMany({
      where: { id: { in: [a.order.id, b.order.id, c.order.id] } }, data: { linkGroupId: "grp-1" },
    });

    const detail = await getOrder(a.order.id);
    expect(detail.linkGroupId).toBe("grp-1");
    expect(detail.linkedOrders).toEqual([
      { id: b.order.id, orderNumber: 1001 },
      { id: c.order.id, orderNumber: 1002 },
    ]);
  });
});

/** Three orders across two customers, with dates and light spread deliberately. */
async function board() {
  const { customer, lead, rider, code } = await fixture();
  const other = await prisma.customer.create({ data: { code: "BETA", name: "Beta Works" } });
  const otherPart = await prisma.part.create({
    data: { customerId: other.id, partNumber: "B-77", eachWeight: "2.0000" },
  });
  await giveSteps(otherPart.id, code.id);

  const acmeEarly = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "PO-111", vsOrderNumber: "VS-900",
    receivedDate: dayFromToday(-10), requestDate: dayFromToday(-1),
    lines: mockupLines(lead.id, rider.id),
  }));
  const acmeLate = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "PO-222",
    receivedDate: dayFromToday(-2), requestDate: dayFromToday(30),
    lines: [{ partId: lead.id, qty: 10, weight: "135.00" }],
  }));
  const betaMid = await asSystem(() => createOrder({
    customerId: other.id, poNumber: "PO-333",
    receivedDate: dayFromToday(-1), requestDate: dayFromToday(4),
    lines: [{ partId: otherPart.id, qty: 5, weight: "10.00" }],
  }));

  return { customer, other, lead, rider, otherPart, acmeEarly, acmeLate, betaMid };
}

const numbersOf = (rows: { orderNumber: number }[]) => rows.map((r) => r.orderNumber);

describe("listOrders", () => {
  beforeEach(truncateAll);

  it("returns a board row per order with summed qty/weight, lead part, loads and light", async () => {
    const { acmeEarly } = await board();
    const rows = await listOrders({});

    expect(rows).toHaveLength(3);
    const row = rows.find((r) => r.id === acmeEarly.order.id)!;
    expect(row).toMatchObject({
      orderNumber: 1000, customerCode: "ACME", customerName: "Acme Gear",
      leadPartNumber: "3541720C3", poNumber: "PO-111", vsOrderNumber: "VS-900",
      qty: 4500, weight: 60750, status: "OPEN", voided: false, loadCount: 14, linked: false,
      light: "did_miss", // request date was yesterday
    });
    expect(row.receivedDate).toBe(dayFromToday(-10));
    expect(row.requestDate).toBe(dayFromToday(-1));
    expect(row.targetDate).toBeNull();
  });

  it("computes each row's light from the two traffic settings, read once per call", async () => {
    await board();
    await asSystem(() => setSetting("traffic_may_miss_days", 40));
    await asSystem(() => setSetting("traffic_will_miss_days", 5));

    const rows = await listOrders({ sort: "requestDate", dir: "asc" });
    // -1 day, +4 days, +30 days against will-miss 5 / may-miss 40.
    expect(rows.map((r) => r.light)).toEqual(["did_miss", "will_miss", "may_miss"]);
  });

  it("hides voided orders by default and shows them with includeVoided", async () => {
    const { acmeLate } = await board();
    await prisma.order.update({ where: { id: acmeLate.order.id }, data: { deletedAt: new Date() } });

    expect(numbersOf(await listOrders({}))).toEqual([1002, 1000]);
    const withVoided = await listOrders({ includeVoided: true });
    expect(numbersOf(withVoided)).toEqual([1002, 1001, 1000]);
    expect(withVoided.find((r) => r.orderNumber === 1001)!.voided).toBe(true);
  });

  it("filters by customer", async () => {
    const { other } = await board();
    expect(numbersOf(await listOrders({ customerId: other.id }))).toEqual([1002]);
  });

  it("filters by status", async () => {
    const { acmeLate } = await board();
    await prisma.order.update({ where: { id: acmeLate.order.id }, data: { status: "SHIPPED" } });

    expect(numbersOf(await listOrders({ status: ["SHIPPED"] }))).toEqual([1001]);
    expect(numbersOf(await listOrders({ status: ["OPEN", "SHIPPED"] }))).toEqual([1002, 1001, 1000]);
  });

  it("filters by received and request date ranges, inclusive of both ends", async () => {
    await board();
    expect(numbersOf(await listOrders({ receivedFrom: dayFromToday(-2) }))).toEqual([1002, 1001]);
    expect(numbersOf(await listOrders({ receivedTo: dayFromToday(-2) }))).toEqual([1001, 1000]);
    expect(numbersOf(await listOrders({ receivedFrom: dayFromToday(-2), receivedTo: dayFromToday(-2) })))
      .toEqual([1001]);
    expect(numbersOf(await listOrders({ requestFrom: dayFromToday(0), requestTo: dayFromToday(10) })))
      .toEqual([1002]);
  });

  it("rejects a malformed date filter, naming the field", async () => {
    await expect(listOrders({ receivedFrom: "07/2026" })).rejects.toMatchObject({
      status: 400, message: expect.stringContaining("Received from"),
    });
    await expect(listOrders({ requestTo: "2026-13-01" })).rejects.toMatchObject({
      status: 400, message: expect.stringContaining("Request to"),
    });
  });

  it("searches order number, PO, VS #, lead part number, and customer code or name", async () => {
    await board();
    expect(numbersOf(await listOrders({ search: "1002" }))).toEqual([1002]);
    expect(numbersOf(await listOrders({ search: "PO-222" }))).toEqual([1001]);
    expect(numbersOf(await listOrders({ search: "vs-900" }))).toEqual([1000]); // case-insensitive
    expect(numbersOf(await listOrders({ search: "3541720C3" }))).toEqual([1001, 1000]);
    expect(numbersOf(await listOrders({ search: "beta" }))).toEqual([1002]); // customer code
    expect(numbersOf(await listOrders({ search: "Acme Gear" }))).toEqual([1001, 1000]); // customer name
    expect(await listOrders({ search: "nothing-matches" })).toEqual([]);
  });

  it("matches only the LEAD part number, not a rider's", async () => {
    await board();
    // 3541720C4 is the rider on order 1000 — searching it must not surface the order.
    expect(await listOrders({ search: "3541720C4" })).toEqual([]);
  });

  it("survives a search term too large for an Int order number", async () => {
    await board();
    expect(await listOrders({ search: "99999999999999" })).toEqual([]);
  });

  it("sorts by request date in both directions", async () => {
    await board();
    expect(numbersOf(await listOrders({ sort: "requestDate", dir: "asc" }))).toEqual([1000, 1002, 1001]);
    expect(numbersOf(await listOrders({ sort: "requestDate", dir: "desc" }))).toEqual([1001, 1002, 1000]);
  });

  it("defaults to newest order number first", async () => {
    await board();
    expect(numbersOf(await listOrders({}))).toEqual([1002, 1001, 1000]);
  });

  it("rejects a sort key it cannot honour rather than silently ignoring it", async () => {
    await board();
    await expect(listOrders({ sort: "bogus" }))
      .rejects.toMatchObject({ status: 400, message: 'Cannot sort orders by "bogus"' });
  });

  it("marks a row linked once it joins a link group", async () => {
    const { acmeEarly, acmeLate } = await board();
    await prisma.order.updateMany({
      where: { id: { in: [acmeEarly.order.id, acmeLate.order.id] } }, data: { linkGroupId: "grp-1" },
    });

    const rows = await listOrders({});
    expect(rows.find((r) => r.orderNumber === 1000)!.linked).toBe(true);
    expect(rows.find((r) => r.orderNumber === 1002)!.linked).toBe(false);
  });
});

describe("exportOrders", () => {
  beforeEach(truncateAll);

  async function sheetOf(buf: Buffer) {
    const wb = new ExcelJS.Workbook();
    // exceljs's own declarations shadow the global Buffer here — see tests/excel.test.ts.
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    return wb.getWorksheet("Orders")!;
  }

  it("writes the board columns with a header row and one row per order", async () => {
    await board();
    const sheet = await sheetOf(await exportOrders({ sort: "requestDate", dir: "asc" }));

    expect(sheet.getRow(1).values).toEqual([undefined,
      "Order #", "Customer code", "Customer name", "Lead part", "PO", "Qty", "Weight",
      "Received", "Request", "Target", "Light", "Status", "Loads", "Linked", "VS #", "Voided"]);

    // Cell by cell rather than `row.values`: an empty target date leaves a hole, and a sparse
    // array compares unhelpfully.
    const cells = (n: number) => sheet.getRow(2).getCell(n).value;
    expect([1, 2, 3, 4, 5, 6, 7].map(cells))
      .toEqual([1000, "ACME", "Acme Gear", "3541720C3", "PO-111", 4500, 60750]);
    expect([8, 9].map(cells)).toEqual([dayFromToday(-10), dayFromToday(-1)]);
    expect(cells(10)).toBeFalsy(); // no target date
    expect([11, 12, 13, 14, 15, 16].map(cells))
      .toEqual(["Did miss", "OPEN", 14, "no", "VS-900", "no"]);
    expect(sheet.rowCount).toBe(4); // header + 3 orders
  });

  it("exports only the filtered set", async () => {
    const { other } = await board();
    const sheet = await sheetOf(await exportOrders({ customerId: other.id }));

    expect(sheet.rowCount).toBe(2);
    expect(sheet.getRow(2).getCell(1).value).toBe(1002);
    expect(sheet.getRow(2).getCell(2).value).toBe("BETA");
  });

  it("marks voided rows when they are included", async () => {
    const { acmeLate } = await board();
    await prisma.order.update({ where: { id: acmeLate.order.id }, data: { deletedAt: new Date() } });

    const hidden = await sheetOf(await exportOrders({}));
    expect(hidden.rowCount).toBe(3);

    const shown = await sheetOf(await exportOrders({ includeVoided: true, sort: "orderNumber", dir: "asc" }));
    expect(shown.rowCount).toBe(4);
    expect(shown.getRow(3).getCell(16).value).toBe("yes"); // order 1001, the voided one
  });
});

describe("updateOrder", () => {
  beforeEach(truncateAll);

  it("PATCHes poNumber/vsOrderNumber/dates/notes and audits a real diff", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "PO-OLD", lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));

    const { order: after, warnings } = await asSystem(() => updateOrder(order.id, {
      poNumber: "PO-NEW", vsOrderNumber: "VS-77", notes: "rush it",
      receivedDate: "2026-08-10", requestDate: "2026-08-17", targetDate: "2026-08-20",
    }));

    expect(after).toMatchObject({
      poNumber: "PO-NEW", vsOrderNumber: "VS-77", notes: "rush it",
      receivedDate: "2026-08-10", requestDate: "2026-08-17", targetDate: "2026-08-20",
    });
    expect(warnings).toEqual([]);

    const [entry] = await readAudit("order", order.id);
    expect(entry.action).toBe("update");
    const before = entry.before as { poNumber: string };
    const diffAfter = entry.after as { poNumber: string };
    expect(before.poNumber).toBe("PO-OLD");
    expect(diffAfter.poNumber).toBe("PO-NEW");
  });

  it("leaves targetDate alone when omitted, and clears it on an explicit null", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, targetDate: "2026-09-01",
      lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));

    const { order: untouched } = await asSystem(() => updateOrder(order.id, { poNumber: "X" }));
    expect(untouched.targetDate).toBe("2026-09-01");

    const { order: cleared } = await asSystem(() => updateOrder(order.id, { targetDate: null }));
    expect(cleared.targetDate).toBeNull();
  });

  it("rejects an unrecognized key — customerId and status have no input path", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    await expect(asSystem(() => updateOrder(order.id, { customerId: "nope" }))).rejects.toBeInstanceOf(ZodError);
    await expect(asSystem(() => updateOrder(order.id, { status: "SHIPPED" }))).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects a malformed date, naming the field", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    await expect(asSystem(() => updateOrder(order.id, { requestDate: "13/2026" })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("Request date") });
  });

  it("404s an unknown order", async () => {
    await expect(asSystem(() => updateOrder("nope", { poNumber: "X" })))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
  });
});

describe("addLine", () => {
  beforeEach(truncateAll);

  it("adds a rider at position max+1, validated like createOrder's lines", async () => {
    const { customer, lead, rider } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: mockupLines(lead.id, rider.id),
    }));
    const rider2 = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "3541720C6", name: "Ring gear D", eachWeight: "13.5000" },
    });

    const { order: after, warnings } = await asSystem(() => addLine(order.id, {
      partId: rider2.id, qty: 7, weight: "94.50", serials: [{ serial: "EC900" }],
    }));

    expect(after.lines).toHaveLength(3);
    expect(after.lines[2]).toMatchObject({ position: 3, partId: rider2.id, revisionNumber: null, qty: 7 });
    expect(after.lines[2].weight).toBe(94.5);
    expect(after.serials.filter((s) => s.lineId === after.lines[2].id).map((s) => s.serial)).toEqual(["EC900"]);
    // The new rider's qty/weight are not reflected in the loads split made at create time.
    expect(warnings).toEqual(["Loads no longer sum to the order — re-split or edit loads"]);
  });

  it("rejects a rider belonging to another customer, and writes nothing", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    const other = await prisma.customer.create({ data: { code: "OTHR", name: "Other Co" } });
    const theirs = await prisma.part.create({
      data: { customerId: other.id, partNumber: "X-9", eachWeight: "1.0000" },
    });

    await expect(asSystem(() => addLine(order.id, { partId: theirs.id, qty: 1, weight: "1.00" })))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("belongs to another customer") });
    expect(await prisma.orderLine.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("404s an unknown order", async () => {
    const { lead } = await fixture();
    await expect(asSystem(() => addLine("nope", { partId: lead.id, qty: 1, weight: "1.00" })))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
  });

  it("shows the new line in the audit entry's after snapshot", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    const rider = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "R-1", eachWeight: "1.0000" },
    });

    await asSystem(() => addLine(order.id, { partId: rider.id, qty: 4, weight: "4.00" }));

    const [entry] = await readAudit("order", order.id);
    expect(entry.action).toBe("update");
    const after = entry.after as {
      lines: { position: number; partId: string; qty: number; part: { partNumber: string } }[];
    };
    expect(after.lines).toHaveLength(2);
    expect(after.lines[1]).toMatchObject({ position: 2, partId: rider.id, qty: 4 });
    expect(after.lines[1].part).toMatchObject({ partNumber: "R-1" });
  });
});

describe("updateLine", () => {
  beforeEach(truncateAll);

  it("changes qty/weight on the lead line, never partId or revisionNumber", async () => {
    const { customer, lead, rider } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: mockupLines(lead.id, rider.id),
    }));
    const leadLineId = order.lines[0].id;

    const { order: after } = await asSystem(() => updateLine(order.id, leadLineId, { qty: 3500, weight: "47250.00" }));
    expect(after.lines[0]).toMatchObject({ qty: 3500, partId: lead.id, revisionNumber: 1 });
    expect(after.lines[0].weight).toBe(47250);

    await expect(asSystem(() => updateLine(order.id, leadLineId, { partId: rider.id })))
      .rejects.toBeInstanceOf(ZodError);
    await expect(asSystem(() => updateLine(order.id, leadLineId, { revisionNumber: 2 })))
      .rejects.toBeInstanceOf(ZodError);

    // Neither rejected patch touched the row.
    const unchanged = await getOrder(order.id);
    expect(unchanged.lines[0]).toMatchObject({ partId: lead.id, revisionNumber: 1, qty: 3500 });
  });

  // Fix-wave R2 finding 3's zod layer applies here too — updateLine's qty is the same field type
  // as a create-time line, and the same absurd value should be refused at parse time regardless
  // of which mutator is asked to set it.
  it("rejects a qty patch above 10,000,000 (zod cap)", async () => {
    const { customer, lead, rider } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: mockupLines(lead.id, rider.id),
    }));
    await expect(asSystem(() => updateLine(order.id, order.lines[0].id, { qty: 10_000_001 })))
      .rejects.toBeInstanceOf(ZodError);
  });

  it("returns the loads-mismatch warning after a qty edit, and clears it once sums match again", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 100, weight: "1350.00" }],
    }));
    const lineId = order.lines[0].id;
    expect(order.loads).toEqual([{ id: expect.any(String), loadNumber: 1, qty: 100, weight: 1350 }]);

    const { warnings: mismatched } =
      await asSystem(() => updateLine(order.id, lineId, { qty: 150, weight: "2025.00" }));
    expect(mismatched).toEqual(["Loads no longer sum to the order — re-split or edit loads"]);

    const { warnings: cleared } =
      await asSystem(() => updateLine(order.id, lineId, { qty: 100, weight: "1350.00" }));
    expect(cleared).toEqual([]);
  });

  it("404s an unknown line id", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    await expect(asSystem(() => updateLine(order.id, "nope", { qty: 2 })))
      .rejects.toMatchObject({ status: 404, message: "Order line not found" });
  });
});

describe("removeLine", () => {
  beforeEach(truncateAll);

  it("refuses to remove the lead line with the exact message", async () => {
    const { customer, lead, rider } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: mockupLines(lead.id, rider.id),
    }));
    await expect(asSystem(() => removeLine(order.id, order.lines[0].id))).rejects.toMatchObject({
      status: 400, message: "The lead part cannot be removed — void the order instead",
    });
    expect(await prisma.orderLine.count({ where: { orderId: order.id } })).toBe(2);
  });

  it("closes the position gap when a rider is removed, ascending per-row updates", async () => {
    const { customer, lead, rider } = await fixture();
    const rider2 = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "3541720C5", name: "Ring gear C", eachWeight: "13.5000" },
    });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [
        { partId: lead.id, qty: 10, weight: "135.00" },
        { partId: rider.id, qty: 5, weight: "67.50" },
        { partId: rider2.id, qty: 3, weight: "40.50" },
      ],
    }));
    const middleLineId = order.lines[1].id;
    const lastLineId = order.lines[2].id;

    const { order: after } = await asSystem(() => removeLine(order.id, middleLineId));

    expect(after.lines).toHaveLength(2);
    expect(after.lines[0]).toMatchObject({ position: 1, partId: lead.id });
    expect(after.lines[1]).toMatchObject({ position: 2, partId: rider2.id, id: lastLineId });
  });

  it("removes the line's own serials along with it", async () => {
    const { customer, lead, rider } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [
        { partId: lead.id, qty: 1, weight: "13.50" },
        { partId: rider.id, qty: 1, weight: "13.50", serials: [{ serial: "EC001" }] },
      ],
    }));
    const riderLineId = order.lines[1].id;

    const { order: after } = await asSystem(() => removeLine(order.id, riderLineId));
    expect(after.serials).toEqual([]);
    expect(await prisma.orderSerial.count({ where: { lineId: riderLineId } })).toBe(0);
  });

  it("404s an unknown line id", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    await expect(asSystem(() => removeLine(order.id, "nope")))
      .rejects.toMatchObject({ status: 404, message: "Order line not found" });
  });

  // Fix-wave R2 finding 6: removeLine used to return the bare OrderDetail, so removing a rider
  // that desynced the order's totals from its (untouched) loads collection reported no warning at
  // all — the hub's `applyMutation` treats a warnings-less response as "clear the banner", exactly
  // backwards from what a freshly-mismatched order needs. addLine/updateLine already return
  // { order, warnings }; removeLine now matches.
  it("returns the loads-mismatch warning when removing a rider desyncs an auto-split order's totals", async () => {
    const { customer, lead, rider } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: mockupLines(lead.id, rider.id),
    }));
    expect(order.loads).toHaveLength(14); // auto-split against the totals BEFORE the removal below

    const riderLineId = order.lines[1].id;
    const { order: after, warnings } = await asSystem(() => removeLine(order.id, riderLineId));

    expect(after.lines).toHaveLength(1);
    expect(warnings).toEqual(["Loads no longer sum to the order — re-split or edit loads"]);
  });
});

describe("replaceContainers", () => {
  beforeEach(truncateAll);

  it("bulk-replaces the order's containers, renumbered from 1", async () => {
    const { customer, lead, containerType } = await fixture();
    const crate = await prisma.containerType.create({ data: { name: "Crate" } });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
      containers: [{ typeId: containerType.id, count: 1 }],
    }));

    const after = await asSystem(() => replaceContainers(order.id, [
      { typeId: crate.id, count: 2, tareWeight: "10.00" },
      { typeId: containerType.id, count: 1 },
    ]));

    expect(after.containers).toHaveLength(2);
    expect(after.containers[0]).toMatchObject({ position: 1, typeId: crate.id, count: 2, tareWeight: 10 });
    expect(after.containers[1]).toMatchObject({ position: 2, typeId: containerType.id, count: 1 });
  });

  it("rejects an unknown container type and writes nothing", async () => {
    const { customer, lead, containerType } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
      containers: [{ typeId: containerType.id, count: 1 }],
    }));

    await expect(asSystem(() => replaceContainers(order.id, [{ typeId: "nope", count: 1 }])))
      .rejects.toMatchObject({ status: 400, message: "That container type does not exist" });
    expect((await getOrder(order.id)).containers).toHaveLength(1); // unchanged
  });

  it("clears every container with an empty list", async () => {
    const { customer, lead, containerType } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
      containers: [{ typeId: containerType.id, count: 1 }],
    }));
    const after = await asSystem(() => replaceContainers(order.id, []));
    expect(after.containers).toEqual([]);
  });
});

describe("replaceContainers: races a concurrent containerType delete", () => {
  beforeEach(truncateAll);

  // Same mechanism as customers.test.ts's "cannot form a reciprocal parent cycle" race and the
  // four writers documented in reference.ts's deleteReference doc comment: assertRefExists (here,
  // inside replaceContainers) and deleteReference's blocker scan both read the containerType row
  // inside their own Serializable transaction, so Postgres SSI aborts whichever side would leave a
  // live container pointing at a type that same instant vanished. Looped because the interleaving
  // is timing-dependent — a single attempt could pass even against a regressed guard.
  it("never leaves a live container pointing at a soft-deleted container type", async () => {
    for (let i = 0; i < 10; i++) {
      await truncateAll();
      const { customer, lead } = await fixture();
      const type = await prisma.containerType.create({ data: { name: `Basket ${i}` } });
      const { order } = await asSystem(() => createOrder({
        customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
      }));

      const results = await Promise.allSettled([
        asSystem(() => replaceContainers(order.id, [{ typeId: type.id, count: 1 }])),
        asSystem(() => deleteReference("containerType", type.id)),
      ]);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(r.reason, `attempt ${i}`).toBeInstanceOf(HttpError);
          expect((r.reason as HttpError).status, `attempt ${i}`).toBeGreaterThanOrEqual(400);
        }
      }

      const [typeRow, containers] = await Promise.all([
        prisma.containerType.findUniqueOrThrow({ where: { id: type.id } }),
        prisma.orderContainer.findMany({ where: { typeId: type.id } }),
      ]);
      const orphaned = typeRow.deletedAt !== null && containers.length > 0;
      expect(orphaned, `orphaned container on attempt ${i}`).toBe(false);
    }
  });
});

describe("replaceSerials", () => {
  beforeEach(truncateAll);

  it("atomically swaps one line's serial set, renumbered from 1", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 2, weight: "27.00", serials: [{ serial: "OLD1" }, { serial: "OLD2" }] }],
    }));
    const lineId = order.lines[0].id;

    const after = await asSystem(() => replaceSerials(order.id, lineId, [
      { serial: "NEW1", description: "heat 1" }, { serial: "NEW2" }, { serial: "NEW3" },
    ]));

    expect(after.serials.map((s) => s.serial)).toEqual(["NEW1", "NEW2", "NEW3"]);
    expect(after.serials.map((s) => s.position)).toEqual([1, 2, 3]);
    expect(after.serials.every((s) => s.lineId === lineId)).toBe(true);
    expect(after.serials[0].description).toBe("heat 1");
  });

  it("rejects an in-payload duplicate, naming the serial, and writes nothing", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 1, weight: "13.50", serials: [{ serial: "KEEP" }] }],
    }));
    const lineId = order.lines[0].id;

    await expect(asSystem(() => replaceSerials(order.id, lineId, [{ serial: "A" }, { serial: "A" }])))
      .rejects.toMatchObject({ status: 400, message: 'Serial "A" is entered twice' });

    expect((await getOrder(order.id)).serials.map((s) => s.serial)).toEqual(["KEEP"]);
  });

  it("clears a line's serials with an empty list", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 1, weight: "13.50", serials: [{ serial: "KEEP" }] }],
    }));
    const after = await asSystem(() => replaceSerials(order.id, order.lines[0].id, []));
    expect(after.serials).toEqual([]);
  });

  it("404s an unknown line id", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    await expect(asSystem(() => replaceSerials(order.id, "nope", [])))
      .rejects.toMatchObject({ status: 404, message: "Order line not found" });
  });
});

describe("replaceCharges", () => {
  beforeEach(truncateAll);

  it("bulk-replaces the order's charges, renumbered from 1", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
      charges: [{ description: "Freight", amount: "50.00" }],
    }));

    const after = await asSystem(() => replaceCharges(order.id, [
      { description: "Straightening", amount: null }, { description: "Freight", amount: "75.00" },
    ]));

    expect(after.charges).toEqual([
      expect.objectContaining({ position: 1, description: "Straightening", amount: null }),
      expect.objectContaining({ position: 2, description: "Freight", amount: 75 }),
    ]);
  });

  it("clears every charge with an empty list", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
      charges: [{ description: "Freight", amount: "50.00" }],
    }));
    const after = await asSystem(() => replaceCharges(order.id, []));
    expect(after.charges).toEqual([]);
  });
});

describe("voidOrder", () => {
  beforeEach(truncateAll);

  it("requires a non-blank reason", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    await expect(asSystem(() => voidOrder(order.id, ""))).rejects.toMatchObject({
      status: 400, message: "A reason is required to void an order",
    });
    await expect(asSystem(() => voidOrder(order.id, "   "))).rejects.toMatchObject({
      status: 400, message: "A reason is required to void an order",
    });
    expect((await getOrder(order.id)).voided).toBe(false);
  });

  it("soft-deletes with the trimmed reason on the audit entry, and never frees the order number", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));

    await asSystem(() => voidOrder(order.id, "  wrong part keyed  "));

    const [entry] = await readAudit("order", order.id);
    expect(entry.action).toBe("delete");
    expect(entry.reason).toBe("wrong part keyed");

    const detail = await getOrder(order.id); // still readable, not 404
    expect(detail.voided).toBe(true);
    expect(detail.orderNumber).toBe(1000);

    expect(await listOrders({})).toEqual([]);
    const withVoided = await listOrders({ includeVoided: true });
    expect(withVoided).toHaveLength(1);
    expect(withVoided[0]).toMatchObject({ orderNumber: 1000, voided: true });
  });

  it("404s an unknown order", async () => {
    await expect(asSystem(() => voidOrder("nope", "reason")))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
  });
});

describe("linkOrder / unlinkOrder", () => {
  beforeEach(truncateAll);

  it("refuses linking orders from two different customers", async () => {
    const { customer, lead, code } = await fixture();
    const other = await prisma.customer.create({ data: { code: "OTHR", name: "Other Co" } });
    const theirPart = await prisma.part.create({
      data: { customerId: other.id, partNumber: "X-1", eachWeight: "1.0000" },
    });
    await giveSteps(theirPart.id, code.id);

    const a = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    const b = await asSystem(() => createOrder({
      customerId: other.id, lines: [{ partId: theirPart.id, qty: 1, weight: "1.00" }],
    }));

    await expect(asSystem(() => linkOrder(a.order.id, b.order.id))).rejects.toMatchObject({
      status: 400, message: "Orders can only be linked within one customer",
    });
  });

  it("refuses linking an order to itself", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    await expect(asSystem(() => linkOrder(order.id, order.id))).rejects.toMatchObject({ status: 400 });
  });

  it("404s when the other side of a link is voided", async () => {
    const { customer, lead } = await fixture();
    const line = { partId: lead.id, qty: 1, weight: "13.50" };
    const a = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const b = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    await asSystem(() => voidOrder(b.order.id, "test"));

    await expect(asSystem(() => linkOrder(a.order.id, b.order.id)))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
  });

  // Union semantics (owner ruling 2026-08-02, superseding spec §5d's original literal wording —
  // see the doc comment on linkOrder). The four cases below are exhaustive and mutually
  // exclusive on (order.linkGroupId, other.linkGroupId): (null, null), (set, null), (null, set),
  // (set, set-and-equal), (set, set-and-different).

  it("mints a fresh group for two groupless orders", async () => {
    const { customer, lead } = await fixture();
    const line = { partId: lead.id, qty: 1, weight: "13.50" };
    const a = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const b = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));

    const linked = await asSystem(() => linkOrder(a.order.id, b.order.id));
    expect(linked.linkGroupId).toBeTruthy();
    expect((await getOrder(b.order.id)).linkGroupId).toBe(linked.linkGroupId);
  });

  it("audits both sides of a simple link with the real before/after linkGroupId", async () => {
    const { customer, lead } = await fixture();
    const line = { partId: lead.id, qty: 1, weight: "13.50" };
    const a = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const b = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));

    const linked = await asSystem(() => linkOrder(a.order.id, b.order.id));
    const groupId = linked.linkGroupId!;

    const [entryA] = await readAudit("order", a.order.id);
    expect(entryA.action).toBe("update");
    expect((entryA.before as { linkGroupId: string | null }).linkGroupId).toBeNull();
    expect((entryA.after as { linkGroupId: string | null }).linkGroupId).toBe(groupId);

    const [entryB] = await readAudit("order", b.order.id);
    expect(entryB.action).toBe("update");
    expect((entryB.before as { linkGroupId: string | null }).linkGroupId).toBeNull();
    expect((entryB.after as { linkGroupId: string | null }).linkGroupId).toBe(groupId);
  });

  it("the groupless side joins the OTHER side's existing group — both directions — without orphaning its groupmates", async () => {
    const { customer, lead } = await fixture();
    const line = { partId: lead.id, qty: 1, weight: "13.50" };
    const a = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const b = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const c = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const d = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));

    // A and B are already linked. Direction 1: `id` (A) is the grouped side, `otherId` (C) is
    // groupless — C joins, and B (not a party to this call at all) must NOT be detached.
    const ab = await asSystem(() => linkOrder(a.order.id, b.order.id));
    const group = ab.linkGroupId!;
    await asSystem(() => linkOrder(a.order.id, c.order.id));
    expect((await getOrder(a.order.id)).linkGroupId).toBe(group);
    expect((await getOrder(b.order.id)).linkGroupId).toBe(group); // not orphaned
    expect((await getOrder(c.order.id)).linkGroupId).toBe(group); // joined

    // Direction 2: `id` (D) is groupless, `otherId` (A) is the grouped side — D joins A's group,
    // and B/C (again, not a party to this call) stay put.
    await asSystem(() => linkOrder(d.order.id, a.order.id));
    expect((await getOrder(d.order.id)).linkGroupId).toBe(group); // joined
    expect((await getOrder(b.order.id)).linkGroupId).toBe(group); // still not orphaned
    expect((await getOrder(c.order.id)).linkGroupId).toBe(group); // still not orphaned
  });

  it("merges two distinct groups into one when both sides are already grouped", async () => {
    const { customer, lead } = await fixture();
    const line = { partId: lead.id, qty: 1, weight: "13.50" };
    const a = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const b = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const c = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const d = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));

    const ab = await asSystem(() => linkOrder(a.order.id, b.order.id));
    const groupAB = ab.linkGroupId!;
    const cd = await asSystem(() => linkOrder(c.order.id, d.order.id));
    const groupCD = cd.linkGroupId!;
    expect(groupAB).not.toBe(groupCD);

    // id's (a's) group is the documented survivor.
    const merged = await asSystem(() => linkOrder(a.order.id, c.order.id));
    expect(merged.linkGroupId).toBe(groupAB);

    const details = await Promise.all([a, b, c, d].map((o) => getOrder(o.order.id)));
    expect(details.map((o) => o.linkGroupId)).toEqual([groupAB, groupAB, groupAB, groupAB]);
  });

  // Fix-wave finding 10: the merge's own findMany (scanning `other`'s group for members to move)
  // had no `deletedAt` filter, so a voided groupmate — read-only by spec §5c/§5a — got its
  // linkGroupId updated (and an audit entry written) right alongside its live siblings. A voided
  // order must stay untouched by ANY mutator, merges included.
  it("excludes a voided member of the absorbed group from the merge — it keeps its old groupId and gets no new audit entry", async () => {
    const { customer, lead } = await fixture();
    const line = { partId: lead.id, qty: 1, weight: "13.50" };
    const a = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const b = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const c = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const d = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));

    await asSystem(() => linkOrder(a.order.id, b.order.id));
    const cd = await asSystem(() => linkOrder(c.order.id, d.order.id));
    const groupCD = cd.linkGroupId!;

    // d, a member of the group about to be absorbed, is voided BEFORE the merge — its own group
    // membership must survive the merge unchanged, exactly like every other order-child mutator
    // already refuses to touch a voided order (the "every mutator refuses a voided order" suite
    // below covers the mutator's own target being voided; this covers a voided BYSTANDER dragged
    // in only because it shares a group with the actual target).
    await asSystem(() => voidOrder(d.order.id, "test: voided before merge"));
    const auditCountBefore = (await readAudit("order", d.order.id)).length;

    const merged = await asSystem(() => linkOrder(a.order.id, c.order.id));
    const groupAB = merged.linkGroupId!;

    // c joined a's group, exactly as the unconditional case above does...
    expect((await getOrder(c.order.id)).linkGroupId).toBe(groupAB);
    // ...but d, voided, is untouched: still carries its OLD groupId (groupCD, never reassigned to
    // groupAB), and got no new audit entry from this merge.
    const dRow = await prisma.order.findUnique({ where: { id: d.order.id }, select: { linkGroupId: true } });
    expect(dRow?.linkGroupId).toBe(groupCD);
    expect((await readAudit("order", d.order.id)).length).toBe(auditCountBefore);
  });

  it("400s re-linking two orders already in the same group, in either direction", async () => {
    const { customer, lead } = await fixture();
    const line = { partId: lead.id, qty: 1, weight: "13.50" };
    const a = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const b = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    await asSystem(() => linkOrder(a.order.id, b.order.id));

    await expect(asSystem(() => linkOrder(a.order.id, b.order.id))).rejects.toMatchObject({
      status: 400, message: "Those orders are already linked",
    });
    await expect(asSystem(() => linkOrder(b.order.id, a.order.id))).rejects.toMatchObject({
      status: 400, message: "Those orders are already linked",
    });
  });

  // Fix-wave finding 9: unlinking down to a group that would STILL hold two or more members
  // leaves them untouched — only the singleton case (below) needs the cascade.
  it("unlink from a trio leaves two linked: the remaining pair keeps its shared groupId untouched", async () => {
    const { customer, lead } = await fixture();
    const line = { partId: lead.id, qty: 1, weight: "13.50" };
    const a = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const b = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const c = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    await asSystem(() => linkOrder(a.order.id, b.order.id));
    await asSystem(() => linkOrder(c.order.id, b.order.id));

    const unlinked = await asSystem(() => unlinkOrder(a.order.id));
    expect(unlinked.linkGroupId).toBeNull();

    const detailB = await getOrder(b.order.id);
    expect(detailB.linkedOrders.map((o) => o.id)).toEqual([c.order.id]);
    // b and c both still carry the SAME shared groupId — genuinely still linked, not merely
    // both non-null by coincidence.
    expect((await getOrder(c.order.id)).linkGroupId).toBe(detailB.linkGroupId);
  });

  // Fix-wave finding 9: unlinking a PAIR down to one remaining member used to leave that
  // survivor's own linkGroupId untouched — a "group of one" that still read `linked: true` on
  // the board (orders.ts's `linked: row.linkGroupId !== null`) while its OWN linkedOrders panel
  // was empty (readDetail finds no other row sharing that groupId), the exact "guard that says no
  // without naming what's blocking" shape this ERP is built to avoid. The survivor's own group
  // membership must collapse right along with the order that just left it.
  it("unlinking a PAIR clears both sides — a lone survivor is not left wearing a linked badge over an empty panel", async () => {
    const { customer, lead } = await fixture();
    const line = { partId: lead.id, qty: 1, weight: "13.50" };
    const a = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    const b = await asSystem(() => createOrder({ customerId: customer.id, lines: [line] }));
    await asSystem(() => linkOrder(a.order.id, b.order.id));

    const unlinked = await asSystem(() => unlinkOrder(a.order.id));
    expect(unlinked.linkGroupId).toBeNull();

    const detailB = await getOrder(b.order.id);
    expect(detailB.linkGroupId).toBeNull();
    expect(detailB.linkedOrders).toEqual([]);

    // Both sides carry a real, distinct audit entry for the clear — b's own history shows it,
    // not just a's.
    const [entryB] = await readAudit("order", b.order.id);
    expect(entryB.action).toBe("update");
    expect((entryB.after as { linkGroupId: string | null }).linkGroupId).toBeNull();
  });

  it("404s an unknown order on either side", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    await expect(asSystem(() => linkOrder("nope", order.id)))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
    await expect(asSystem(() => linkOrder(order.id, "nope")))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
    await expect(asSystem(() => unlinkOrder("nope")))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
  });
});

describe("every mutator refuses a voided order", () => {
  beforeEach(truncateAll);

  it("404s update, every line op, every replace op, void again, link and unlink", async () => {
    const { customer, lead, rider, containerType } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: lead.id, qty: 10, weight: "135.00" }, { partId: rider.id, qty: 5, weight: "67.50" }],
      containers: [{ typeId: containerType.id, count: 1 }],
    }));
    const other = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 1, weight: "13.50" }],
    }));
    const lineId = order.lines[0].id;

    await asSystem(() => voidOrder(order.id, "wrong part keyed"));

    const notFound = { status: 404, message: "Order not found" };
    await expect(asSystem(() => updateOrder(order.id, { poNumber: "X" }))).rejects.toMatchObject(notFound);
    await expect(asSystem(() => addLine(order.id, { partId: rider.id, qty: 1, weight: "13.50" })))
      .rejects.toMatchObject(notFound);
    await expect(asSystem(() => updateLine(order.id, lineId, { qty: 2 }))).rejects.toMatchObject(notFound);
    await expect(asSystem(() => removeLine(order.id, lineId))).rejects.toMatchObject(notFound);
    await expect(asSystem(() => replaceContainers(order.id, []))).rejects.toMatchObject(notFound);
    await expect(asSystem(() => replaceSerials(order.id, lineId, []))).rejects.toMatchObject(notFound);
    await expect(asSystem(() => replaceCharges(order.id, []))).rejects.toMatchObject(notFound);
    await expect(asSystem(() => voidOrder(order.id, "again"))).rejects.toMatchObject(notFound);
    await expect(asSystem(() => linkOrder(order.id, other.order.id))).rejects.toMatchObject(notFound);
    await expect(asSystem(() => unlinkOrder(order.id))).rejects.toMatchObject(notFound);
  });
});

// Fix-wave R2 finding 7: parts are deletable once every order referencing them is voided
// (parts.ts's deletePart), but the hub's Process section read the LIVE part (getRevision's own
// part-liveness gate) to show a voided order's locked recipe — 404ing "Part not found" instead of
// showing paperwork that is, by spec, supposed to stay readable forever. `getLockedRevision`
// resolves the order (voided included — reads never lock out on a voided order, spec §5c), takes
// the lead line's own stored (partId, revisionNumber) pair, and reads the revision content through
// `getRevisionContentUnchecked` (part-process-steps.ts) — the same tables/shape `getRevision`
// itself reads, deliberately without that function's live-part gate, because the order's own
// stored reference — not the part's current liveness — is what this read is anchored on.
describe("getLockedRevision", () => {
  beforeEach(truncateAll);

  it("returns the same content getRevision itself would, for a normal (non-voided) order", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 10, weight: "135.00" }],
    }));

    const viaOrder = await asSystem(() => getLockedRevision(order.id));
    const viaPart = await getRevision(lead.id, 1);
    expect(viaOrder).toEqual(viaPart);
    expect(viaOrder.steps).toHaveLength(1);
    expect(viaOrder.steps[0]).toMatchObject({ instruction: "Austenitize at 1650F." });
  });

  it("stays readable (200 with the locked content) after the order is voided AND the lead part is later soft-deleted", async () => {
    const { customer, lead } = await fixture();
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: lead.id, qty: 10, weight: "135.00" }],
    }));

    await asSystem(() => voidOrder(order.id, "wrong customer"));
    // Only legal because the order referencing it is now voided — deletePart's own "live order"
    // guard (parts.ts) would otherwise refuse this.
    await asSystem(() => deletePart(lead.id, "superseded by a corrected part"));

    const detail = await asSystem(() => getLockedRevision(order.id));
    expect(detail.revisionNumber).toBe(1);
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0]).toMatchObject({ instruction: "Austenitize at 1650F." });

    // Confirms this is genuinely testing the deliberate exception, not something getRevision
    // would already have returned: the ordinary, live-part-gated read now 404s on this same part.
    await expect(getRevision(lead.id, 1)).rejects.toMatchObject({ status: 404, message: "Part not found" });
  });

  it("404s an unknown order id", async () => {
    await expect(asSystem(() => getLockedRevision("nope")))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
  });
});
