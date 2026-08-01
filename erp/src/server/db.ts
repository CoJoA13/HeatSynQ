import { PrismaClient } from "../../prisma/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// PostgreSQL requires a driver adapter in Prisma 7. The connection string is read here rather
// than from prisma.config.ts because tests rewrite process.env.DATABASE_URL in
// tests/helpers/setup.ts (a setupFile, so it runs before this module is imported) to point the
// process at erp_test — the same reason the v6 `datasources: { db: { url } }` override existed.
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
