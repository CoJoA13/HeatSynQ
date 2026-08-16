import type { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import {
  TEMPLATE_DOC_TYPES, defaultConfigFor, type TemplateDocTypeString,
} from "@/lib/template-contracts/index";

// The by-construction singletons + the eight PUBLISHED "Standard" document templates, re-seeded in
// ONE place (Phase 8B §5.3). `truncateAll` (tests) and the practice reset (T13) both restore them
// from here — a NON-test-only module, so the reset reuses no test-only tooling. Template config
// comes from `defaultConfigFor` — the drift-guarded TS DEFAULT_CONFIG constants, NEVER a re-typed
// literal (this is the 4th consumer of those constants; a hand-rolled copy is exactly the drift the
// guard exists to catch). Callers that TRUNCATE first (truncateAll, the reset) must call this AFTER
// the truncate and BEFORE any business rows, or the DB is left in the impossible no-billing-config /
// no-printable-templates state.

export function templateId(docType: TemplateDocTypeString): string {
  return `standard-${docType.toLowerCase().replace(/_/g, "-")}`;
}

export function templateVersionId(docType: TemplateDocTypeString): string {
  return `${templateId(docType)}-v1`;
}

type Db = Prisma.TransactionClient | typeof prisma;

export async function reseedSingletons(db: Db = prisma): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "BillingConfig" ("id", "billForCertDefault", "updatedAt")
    VALUES ('singleton', false, now())
    ON CONFLICT ("id") DO NOTHING`;
  await db.$executeRaw`
    INSERT INTO "SetupState" ("id", "updatedAt")
    VALUES ('singleton', now())
    ON CONFLICT ("id") DO NOTHING`;

  const now = new Date();
  await db.documentTemplate.createMany({
    data: TEMPLATE_DOC_TYPES.map((docType) => ({
      id: templateId(docType), docType, name: "Standard", isDefault: true, updatedAt: now,
    })),
  });
  await db.documentTemplateVersion.createMany({
    data: TEMPLATE_DOC_TYPES.map((docType) => ({
      id: templateVersionId(docType), templateId: templateId(docType), versionNumber: 1,
      status: "PUBLISHED", config: defaultConfigFor(docType) as unknown as Prisma.InputJsonValue,
      publishedAt: now, updatedAt: now,
    })),
  });
  // A separate 3rd statement: the two createMany calls cannot reference each other's rows mid-flight.
  await db.$executeRaw`
    UPDATE "DocumentTemplate" t SET "publishedVersionId" = v."id"
    FROM "DocumentTemplateVersion" v
    WHERE v."templateId" = t."id" AND v."versionNumber" = 1`;
}
