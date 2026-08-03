import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";

describe("orders schema", () => {
  beforeEach(truncateAll);

  it("stores the order graph — line/serial, container/type, load, charge, draft, saved view, stored document, both attachment kinds", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 },
    });
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const user = await prisma.user.create({
      data: { username: "op1", passwordHash: "x", displayName: "Op One" },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: 1001,
        customerId: customer.id,
        receivedDate: new Date("2026-08-01"),
        requestDate: new Date("2026-08-05"),
      },
    });
    const line = await prisma.orderLine.create({
      data: { orderId: order.id, position: 1, partId: part.id, revisionNumber: 1, qty: 10, weight: 25.5 },
    });
    await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: line.id, position: 1, serial: "EC001" },
    });
    const container = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: containerType.id, count: 1 },
    });
    await prisma.load.create({ data: { orderId: order.id, loadNumber: 1, qty: 10 } });
    await prisma.orderCharge.create({ data: { orderId: order.id, position: 1, description: "Freight" } });
    await prisma.storedDocument.create({
      data: { orderId: order.id, kind: "TRAVELER", fileData: Buffer.from("pdf-bytes") },
    });
    await prisma.partAttachment.create({
      data: {
        partId: part.id, filename: "spec.pdf", mimeType: "application/pdf",
        size: 3, fileData: Buffer.from("abc"),
      },
    });
    await prisma.orderAttachment.create({
      data: {
        orderId: order.id, filename: "note.pdf", mimeType: "application/pdf",
        size: 3, fileData: Buffer.from("xyz"),
      },
    });
    await prisma.orderDraft.create({ data: { userId: user.id, payload: { customerId: customer.id } } });
    await prisma.savedView.create({
      data: { userId: user.id, name: "My Board", config: { columns: ["orderNumber"] } },
    });

    const back = await prisma.order.findFirst({
      where: { id: order.id },
      include: {
        lines: { include: { serials: true, part: true } },
        containers: { include: { type: true } },
        loads: true,
        charges: true,
        documents: true,
        attachments: true,
      },
    });
    expect(back?.lines[0]?.serials[0]?.serial).toBe("EC001");
    expect(back?.lines[0]?.part.partNumber).toBe("P-1");
    expect(back?.containers[0]?.type.id).toBe(containerType.id);
    expect(back?.containers[0]?.id).toBe(container.id);
    expect(back?.loads[0]?.loadNumber).toBe(1);
    expect(back?.charges[0]?.description).toBe("Freight");
    expect(back?.documents[0]?.kind).toBe("TRAVELER");
    expect(back?.attachments[0]?.filename).toBe("note.pdf");

    const partBack = await prisma.part.findFirst({
      where: { id: part.id }, include: { attachments: true, orderLines: true },
    });
    expect(partBack?.attachments[0]?.filename).toBe("spec.pdf");
    expect(partBack?.orderLines[0]?.id).toBe(line.id);

    const draftBack = await prisma.orderDraft.findFirst({ where: { userId: user.id } });
    expect((draftBack?.payload as { customerId: string } | null)?.customerId).toBe(customer.id);

    const viewBack = await prisma.savedView.findFirst({ where: { userId: user.id } });
    expect(viewBack?.name).toBe("My Board");
  });

  // The design spec's no-reuse contract (§4): a voided order keeps its number forever, so a
  // duplicate must still be rejected even once the original is soft-deleted — the opposite of
  // every partial-unique column elsewhere in the schema, and exactly why orderNumber stays a
  // plain @unique (tests/partial-unique-sweep.test.ts carries the matching allowlist entry).
  it("orderNumber uniqueness rejects a duplicate even when the first order is soft-deleted", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const orderData = {
      customerId: customer.id,
      receivedDate: new Date("2026-08-01"),
      requestDate: new Date("2026-08-05"),
    };
    const first = await prisma.order.create({ data: { orderNumber: 2001, ...orderData } });
    await prisma.order.update({ where: { id: first.id }, data: { deletedAt: new Date() } }); // voided

    await expect(prisma.order.create({ data: { orderNumber: 2001, ...orderData } })).rejects.toThrow();
  });

  it("SavedView.name is unique only among live rows, per user", async () => {
    const user = await prisma.user.create({
      data: { username: "op2", passwordHash: "x", displayName: "Op Two" },
    });
    const v1 = await prisma.savedView.create({ data: { userId: user.id, name: "Board", config: {} } });
    await prisma.savedView.update({ where: { id: v1.id }, data: { deletedAt: new Date() } });
    const v2 = await prisma.savedView.create({ data: { userId: user.id, name: "Board", config: {} } }); // must not throw
    expect(v2.id).not.toBe(v1.id);
    await expect(
      prisma.savedView.create({ data: { userId: user.id, name: "Board", config: {} } }),
    ).rejects.toThrow();
  });
});

// Folded into Task 6 from the Task 4 review (progress.md: "CHECK constraint on Part.loadQty
// (hang class) -> fold into T6"). splitLoads (src/lib/load-split.ts) loops `while (remainingQty >
// 0)`, dividing the totals by a piece count derived from loadQty/loadWeight each iteration — a
// loadQty of 0 (or a non-positive loadWeight) would never shrink remainingQty and hang the
// request forever. parts.ts's zod schema already refuses 0/negative at the app layer, so these
// CHECK constraints are a DB-level backstop against anything that bypasses it (a raw SQL script,
// a future migration, a manual edit) — not something normal operation is expected to trip.
describe("Part load-cap CHECK constraints (defense-in-depth for splitLoads)", () => {
  beforeEach(truncateAll);

  it("rejects loadQty = 0 at the database level, bypassing the app layer entirely", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-CHK-1", eachWeight: "1.0000", loadQty: 5 },
    });

    await expect(
      prisma.$executeRaw`UPDATE "Part" SET "loadQty" = 0 WHERE "id" = ${part.id}`,
    ).rejects.toMatchObject({
      code: "P2010",
      meta: expect.objectContaining({
        driverAdapterError: expect.objectContaining({
          cause: expect.objectContaining({ originalCode: "23514" }),
        }),
      }),
    });
    // Nothing was written — the failed statement did not silently partially apply.
    expect((await prisma.part.findFirstOrThrow({ where: { id: part.id } })).loadQty).toBe(5);
  });

  it("accepts a null loadQty (no cap) but rejects a negative one", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-CHK-2", eachWeight: "1.0000" }, // loadQty null
    });
    expect(part.loadQty).toBeNull(); // NULL passes the CHECK (IS NULL OR ...) — no cap is legal

    await expect(
      prisma.$executeRaw`UPDATE "Part" SET "loadQty" = -1 WHERE "id" = ${part.id}`,
    ).rejects.toMatchObject({ code: "P2010" });
  });

  it("rejects loadWeight <= 0 at the database level, bypassing the app layer entirely", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-CHK-3", eachWeight: "1.0000", loadWeight: "10.00" },
    });

    await expect(
      prisma.$executeRaw`UPDATE "Part" SET "loadWeight" = 0 WHERE "id" = ${part.id}`,
    ).rejects.toMatchObject({
      code: "P2010",
      meta: expect.objectContaining({
        driverAdapterError: expect.objectContaining({
          cause: expect.objectContaining({ originalCode: "23514" }),
        }),
      }),
    });
    await expect(
      prisma.$executeRaw`UPDATE "Part" SET "loadWeight" = -5.00 WHERE "id" = ${part.id}`,
    ).rejects.toMatchObject({ code: "P2010" });
  });

  it("an INSERT (not just UPDATE) attempting loadQty = 0 is rejected the same way", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    await expect(prisma.$executeRaw`
      INSERT INTO "Part" ("id", "customerId", "partNumber", "eachWeight", "loadQty", "updatedAt")
      VALUES ('chk-insert-1', ${customer.id}, 'P-CHK-4', 1.0000, 0, now())
    `).rejects.toMatchObject({ code: "P2010" });
    expect(await prisma.part.findFirst({ where: { id: "chk-insert-1" } })).toBeNull();
  });
});
