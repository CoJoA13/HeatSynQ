import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { ALL_PERMISSIONS } from "../src/server/permissions";

const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.role.upsert({
    where: { name: "Admin" },
    update: {},
    create: { name: "Admin" },
  });
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
