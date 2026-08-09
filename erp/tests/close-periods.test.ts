import { beforeEach, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { truncateAll } from "./helpers/db";

beforeEach(truncateAll);

it("can create a ClosePeriod, GlExportBatch, and GlPosting", async () => {
  const period = await prisma.closePeriod.create({
    data: {
      year: 2026, month: 7, beginningAr: 0, invoicedTotal: 100, creditTotal: 0,
      paymentTotal: 40, discountTotal: 0, writeOffTotal: 0, endingAr: 60, agingEndingAr: 60,
    },
  });
  const batch = await prisma.glExportBatch.create({
    data: {
      exportNumber: 1000, closePeriodId: period.id, periodEnd: new Date("2026-07-31"),
      fileName: "gl-2026-07.csv", file: new Uint8Array([1]), register: new Uint8Array([2]),
    },
  });
  await prisma.glPosting.create({
    data: {
      batchId: batch.id, sourceType: "INVOICE", sourceId: "x", glDate: new Date("2026-07-15"),
      debit: 100, credit: 0, side: "SALES",
    },
  });
  expect(await prisma.glPosting.count({ where: { batchId: batch.id } })).toBe(1);
});
