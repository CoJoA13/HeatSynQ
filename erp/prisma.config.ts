import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // v7's `migrate dev` no longer auto-seeds, and `prisma.seed` in package.json is no longer
    // read. This is the only place the seed command is declared; `npx prisma db seed` uses it.
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
