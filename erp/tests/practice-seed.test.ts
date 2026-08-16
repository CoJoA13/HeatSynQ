import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { reseedSingletons, templateId, templateVersionId } from "@/server/practice-seed";
import { TEMPLATE_DOC_TYPES, defaultConfigFor } from "@/lib/template-contracts/index";

describe("reseedSingletons (Phase 8B §5.3)", () => {
  beforeEach(truncateAll);

  it("restores BillingConfig + SetupState + the 8 PUBLISHED Standard templates from defaultConfigFor", async () => {
    // Wipe the singletons + templates (a post-truncate DB before the re-seed).
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "DocumentTemplateVersion", "DocumentTemplate", "BillingConfig", "SetupState" CASCADE',
    );
    expect(await prisma.documentTemplate.count()).toBe(0);

    await reseedSingletons();

    expect((await prisma.billingConfig.findFirst({ where: { id: "singleton" } }))?.id).toBe("singleton");
    expect((await prisma.setupState.findFirst({ where: { id: "singleton" } }))?.id).toBe("singleton");
    expect(await prisma.documentTemplate.count()).toBe(TEMPLATE_DOC_TYPES.length);

    for (const dt of TEMPLATE_DOC_TYPES) {
      const tpl = await prisma.documentTemplate.findFirst({ where: { id: templateId(dt) } });
      expect(tpl?.isDefault).toBe(true);
      expect(tpl?.publishedVersionId).toBe(templateVersionId(dt));
      const ver = await prisma.documentTemplateVersion.findFirst({ where: { id: templateVersionId(dt) } });
      expect(ver?.status).toBe("PUBLISHED");
      // Drift guard: the re-seeded config deep-equals the canonical DEFAULT_CONFIG constants.
      expect(ver?.config).toEqual(defaultConfigFor(dt));
    }
  });

  it("truncateAll still leaves the singleton-complete baseline after the reseedSingletons refactor", async () => {
    expect((await prisma.billingConfig.findFirst({ where: { id: "singleton" } }))?.id).toBe("singleton");
    expect((await prisma.setupState.findFirst({ where: { id: "singleton" } }))?.id).toBe("singleton");
    expect(await prisma.documentTemplate.count()).toBe(TEMPLATE_DOC_TYPES.length);
  });
});
