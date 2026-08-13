import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateVersionId } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder } from "@/server/orders";
import { storeDocument } from "@/server/documents";
import { renderPdf } from "@/server/pdf/render";

/**
 * Phase 7 Task 7 — the traveler conversion and the stamp plumbing: `storeDocument`'s optional
 * `templateVersionId` (the plumbing Tasks 8–14 reuse), `buildTravelerDefinition(data, config)`
 * consuming the backfilled TemplateConfig, and `printTraveler` resolving its template on its own
 * claimed transaction. The GOLDEN-COMPAT gate lives in tests/traveler.test.ts, which this task
 * leaves untouched — everything here is the config-driven half.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** A minimal single-load order (loadQty ≥ qty → exactly one load, one traveler sheet). */
async function miniOrder(partExtra: { processName?: string } = {}) {
  const customer = await prisma.customer.create({ data: { code: "TPL", name: "Template Test Co" } });
  const code = await prisma.processStepCode.create({ data: { code: "AUS", name: "Austemper" } });
  const part = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: "TPL-1", name: "Template Part",
      eachWeight: "1.0000", loadQty: 100, ...partExtra,
    },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Pre-heat, then quench." },
  });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "10.00" }],
  }));
  return { customer, part, order };
}

// ------------------------------------------------------------------------------------------------
// The stamp plumbing (brief item 1): storeDocument's optional templateVersionId
// ------------------------------------------------------------------------------------------------

describe("storeDocument — the templateVersionId stamp", () => {
  beforeEach(truncateAll);

  it("a stored row carries the template version id it was given", async () => {
    const { order } = await miniOrder();
    const pdf = await renderPdf({ content: [{ text: "stamped" }] });
    const meta = await asSystem(() => prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf,
        templateVersionId("TRAVELER"))));

    const row = await prisma.storedDocument.findUnique({
      where: { id: meta.id }, select: { templateVersionId: true },
    });
    expect(row!.templateVersionId).toBe("standard-traveler-v1");
  });

  it("omitting the stamp stores null — the pre-Phase-7 call shape is untouched", async () => {
    const { order } = await miniOrder();
    const pdf = await renderPdf({ content: [{ text: "unstamped" }] });
    const meta = await asSystem(() => prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf)));

    const row = await prisma.storedDocument.findUnique({
      where: { id: meta.id }, select: { templateVersionId: true },
    });
    expect(row!.templateVersionId).toBeNull();
  });

  it("the stamp rides in the audit payload as metadata — never the bytes", async () => {
    const { order } = await miniOrder();
    const pdf = await renderPdf({ content: [{ text: "audited" }] });
    const meta = await asSystem(() => prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf,
        templateVersionId("TRAVELER"))));

    const entry = await prisma.auditLog.findFirst({
      where: { entity: "storedDocument", entityId: meta.id, action: "create" },
    });
    expect(entry).not.toBeNull();
    const after = entry!.after as Record<string, unknown>;
    expect(after.templateVersionId).toBe("standard-traveler-v1");
    expect(JSON.stringify(after)).not.toContain("%PDF");
  });
});
