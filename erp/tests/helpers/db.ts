import { prisma } from "@/server/db";
import {
  TEMPLATE_DOC_TYPES, defaultConfigFor, type TemplateDocTypeString,
} from "@/lib/template-contracts/index";
import type { Prisma } from "../../prisma/generated/prisma/client";

/** 'MOS_SHIPPER' → 'standard-mos-shipper' — the seed migration's fixed template row ids,
 *  re-created by `truncateAll()` below after every TRUNCATE. Exported ONCE from here (Task 3
 *  review carry): the drift guard and the Task 4+ service fixtures reference the same seeded
 *  rows, and a second hand-rolled copy of the minting rule is exactly the drift the guard
 *  exists to catch. */
export function templateId(docType: TemplateDocTypeString): string {
  return `standard-${docType.toLowerCase().replace(/_/g, "-")}`;
}

/** The seeded template's v1 PUBLISHED version id ('standard-traveler-v1'). */
export function templateVersionId(docType: TemplateDocTypeString): string {
  return `${templateId(docType)}-v1`;
}

/**
 * Deletes all rows from every table except _prisma_migrations, then restores the rows the
 * schema guarantees always exist.
 *
 * `BillingConfig` is a singleton by construction (P5A design spec §4.5): a hand-written
 * `CHECK ("id" = 'singleton')` pins it to one row, and the migration that creates the table seeds
 * that row — deliberately, so `getBillingConfig` is a plain `findFirst` and `setBillingConfig` a
 * plain audited update with a real before-snapshot, rather than a lazy create-on-first-read. A
 * bare TRUNCATE deletes it, which would make every test run against a database in a state the
 * production schema cannot be in, and would push the first service that reads it toward exactly
 * the lazy create the spec rules out. Re-seeding it here keeps the invariant true everywhere.
 * `SetupState` (Phase 8B §7) is the same by-construction singleton once more — re-seeded here for
 * the same reason, so `getSetupState` stays a plain `findFirst`.
 *
 * The eight "Standard" document templates (Phase 7 spec §9) are the same invariant one phase
 * over: the seed migration guarantees every docType a live default template with a PUBLISHED v1,
 * and the print path may assume that resolution never dereferences null. The re-seed is built
 * from the TS `DEFAULT_CONFIG` constants — the canonical copy — NOT from the migration's SQL
 * literals, so tests start from factory state (code-default standing texts; the migration's
 * Setting-value COALESCE copies are its own upgrade concern, drift-guarded by
 * tests/template-seed.test.ts against the SQL file itself). Fixed ids match the migration's
 * (standard-<doctype> / -v1); the pointer UPDATE runs as one statement because the two
 * createMany calls cannot reference each other's rows mid-flight.
 */
export async function truncateAll(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
  await prisma.$executeRaw`
    INSERT INTO "BillingConfig" ("id", "billForCertDefault", "updatedAt")
    VALUES ('singleton', false, now())
    ON CONFLICT ("id") DO NOTHING`;
  await prisma.$executeRaw`
    INSERT INTO "SetupState" ("id", "updatedAt")
    VALUES ('singleton', now())
    ON CONFLICT ("id") DO NOTHING`;

  const now = new Date();
  await prisma.documentTemplate.createMany({
    data: TEMPLATE_DOC_TYPES.map((docType) => ({
      id: templateId(docType), docType, name: "Standard", isDefault: true, updatedAt: now,
    })),
  });
  await prisma.documentTemplateVersion.createMany({
    data: TEMPLATE_DOC_TYPES.map((docType) => ({
      id: templateVersionId(docType), templateId: templateId(docType), versionNumber: 1,
      status: "PUBLISHED", config: defaultConfigFor(docType) as unknown as Prisma.InputJsonValue,
      publishedAt: now, updatedAt: now,
    })),
  });
  await prisma.$executeRaw`
    UPDATE "DocumentTemplate" t SET "publishedVersionId" = v."id"
    FROM "DocumentTemplateVersion" v
    WHERE v."templateId" = t."id" AND v."versionNumber" = 1`;
}

export { prisma };
