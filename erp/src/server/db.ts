import { PrismaClient } from "../../prisma/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// PostgreSQL requires a driver adapter in Prisma 7. The connection string is read here rather
// than from prisma.config.ts because tests rewrite process.env.DATABASE_URL in
// tests/helpers/setup.ts (a setupFile, so it runs before this module is imported) to point the
// process at erp_test — the same reason the v6 `datasources: { db: { url } }` override existed.

// Under Prisma 6, an unset DATABASE_URL fell through to the schema's env("DATABASE_URL") and
// threw a named error. PrismaPg({ connectionString: undefined }) has no such fallthrough — it
// lets node-postgres silently fall back to PGHOST/PGUSER/system defaults instead, i.e. a silent
// misconnection rather than a loud failure. Restore v6's loud-failure behaviour explicitly.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
