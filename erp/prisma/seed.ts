import "dotenv/config";
import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
import { ALL_PERMISSIONS } from "../src/server/permissions";

// Same guard, and the same reason, as src/server/db.ts: PrismaPg({ connectionString: undefined })
// does not fail — node-postgres falls back to PGHOST/PGUSER/system defaults, so an unset
// DATABASE_URL silently seeds whatever database happens to be reachable. It matters more here
// than in db.ts, because this script writes: it creates the admin role and an admin user with a
// known default password. `npx prisma db seed` would be caught by prisma.config.ts's
// env("DATABASE_URL"), but `npm run db:seed` runs `tsx prisma/seed.ts` directly and never loads
// that config — and it is the form every doc tells you to run.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  // Not upsert: Role.name is unique only among live rows, but the client still types it unique.
  // upsert's where: { name } matches by name alone (ignoring deletedAt), so if Admin were ever
  // soft-deleted, upsert would silently reattach the admin user to that dead, invisible row
  // instead of creating a fresh one — no error, just wrong. Find-then-create, filtered on
  // deletedAt: null, is the fix; the seed is single-threaded so no race is possible between the
  // read and the create.
  const admin =
    (await prisma.role.findFirst({ where: { name: "Admin", deletedAt: null } })) ??
    (await prisma.role.create({ data: { name: "Admin" } }));
  for (const permission of ALL_PERMISSIONS) {
    await prisma.rolePermission.upsert({
      where: { roleId_permission: { roleId: admin.id, permission } },
      update: {},
      create: { roleId: admin.id, permission },
    });
  }
  await prisma.user.upsert({
    where: { username: "admin" },
    update: { roleId: admin.id },
    create: {
      username: "admin",
      displayName: "Administrator",
      passwordHash: await argon2.hash("admin"),
      roleId: admin.id,
    },
  });
  console.log("Seeded Admin role + admin user (password: admin — change it after first login).");
}

main().finally(() => prisma.$disconnect());
