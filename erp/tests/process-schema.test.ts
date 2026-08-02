import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";

describe("process steps schema", () => {
  beforeEach(truncateAll);

  it("stores a revision -> step -> value graph and a template -> step graph", async () => {
    const customer = await prisma.customer.create({ data: { code: "AC", name: "Acme" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "P-1", eachWeight: 1 },
    });
    const code = await prisma.processStepCode.create({ data: { code: "HT-01", name: "Austenitize" } });
    const def = await prisma.processStepFieldDef.create({
      data: { codeId: code.id, label: "Temperature", type: "NUMBER", unit: "F", sort: 1 },
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    const step = await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "per spec" },
    });
    await prisma.partProcessStepValue.create({ data: { stepId: step.id, fieldDefId: def.id, value: "1650" } });
    const tpl = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplateStep.create({
      data: { templateId: tpl.id, position: 1, codeId: code.id, boilerplate: "load per racking sheet" },
    });

    const back = await prisma.partProcessRevision.findFirst({
      where: { partId: part.id }, include: { steps: { include: { values: true } } },
    });
    expect(back?.steps[0]?.values[0]?.value).toBe("1650");
  });

  it("ProcessTemplate.name is unique only among live rows", async () => {
    const t1 = await prisma.processTemplate.create({ data: { name: "Austemper" } });
    await prisma.processTemplate.update({ where: { id: t1.id }, data: { deletedAt: new Date() } });
    const t2 = await prisma.processTemplate.create({ data: { name: "Austemper" } }); // must not throw
    expect(t2.id).not.toBe(t1.id);
    await expect(prisma.processTemplate.create({ data: { name: "Austemper" } })).rejects.toThrow();
  });
});
