import "dotenv/config";
import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
import { ALL_PERMISSIONS } from "../src/server/permissions";

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
