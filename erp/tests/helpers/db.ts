import { prisma } from "@/server/db";

/**
 * Deletes all rows from every table except _prisma_migrations, then restores the one row the
 * schema guarantees always exists.
 *
 * `BillingConfig` is a singleton by construction (P5A design spec §4.5): a hand-written
 * `CHECK ("id" = 'singleton')` pins it to one row, and the migration that creates the table seeds
 * that row — deliberately, so `getBillingConfig` is a plain `findFirst` and `setBillingConfig` a
 * plain audited update with a real before-snapshot, rather than a lazy create-on-first-read. A
 * bare TRUNCATE deletes it, which would make every test run against a database in a state the
 * production schema cannot be in, and would push the first service that reads it toward exactly
 * the lazy create the spec rules out. Re-seeding it here keeps the invariant true everywhere.
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
}

export { prisma };
