import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { findBlockers } from "@/server/reference-blockers";
import { assertRefExists } from "@/server/reference-guards";
import { HttpError } from "@/server/errors";

async function fixture() {
  const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 } });
  const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
  return { customer, part, code };
}
const step = (revisionId: string, codeId: string, position = 1) =>
  prisma.partProcessStep.create({ data: { revisionId, codeId, position, instruction: "" } });

describe("findBlockers targeting processStepCode", () => {
  beforeEach(truncateAll);

  it("lists a part once even when two revisions use the code, and a template by name", async () => {
    const { part, code } = await fixture();
    const r1 = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1, lockedAt: new Date() } });
    const r2 = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 2 } });
    await step(r1.id, code.id); await step(r2.id, code.id);
    const tpl = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplateStep.create({ data: { templateId: tpl.id, position: 1, codeId: code.id } });

    const blockers = await findBlockers("processStepCode", code.id);
    expect(blockers).toHaveLength(2);
    const labels = blockers.map((b) => `${b.entityLabel}:${b.name}`).sort();
    expect(labels).toEqual(["Part:AC · P-1", "Template:Austemper"]);
    expect(blockers.find((b) => b.entityLabel === "Part")?.href).toBe(`/parts/${part.id}`);
    expect(blockers.find((b) => b.entityLabel === "Template")?.href).toBe(`/processes/templates/${tpl.id}`);
  });

  it("liveWhere: steps under a soft-deleted part or template do not block", async () => {
    const { part, code } = await fixture();
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await step(rev.id, code.id);
    const tpl = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplateStep.create({ data: { templateId: tpl.id, position: 1, codeId: code.id } });
    await prisma.part.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
    await prisma.processTemplate.update({ where: { id: tpl.id }, data: { deletedAt: new Date() } });
    expect(await findBlockers("processStepCode", code.id)).toHaveLength(0);
  });

  it("assertRefExists accepts a live (even inactive) code and 400s a soft-deleted one", async () => {
    const { code } = await fixture();
    await prisma.processStepCode.update({ where: { id: code.id }, data: { active: false } });
    await prisma.$transaction(async (tx) => { await assertRefExists("processStepCode", code.id, tx); });
    await prisma.processStepCode.update({ where: { id: code.id }, data: { deletedAt: new Date() } });
    await expect(
      prisma.$transaction(async (tx) => { await assertRefExists("processStepCode", code.id, tx); }),
    ).rejects.toThrow(HttpError);
  });
});
