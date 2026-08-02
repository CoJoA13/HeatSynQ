FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:25-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# prisma.config.ts declares its datasource via env("DATABASE_URL"), which throws at
# config-load time (before any command logic runs) if the var is unset. `prisma generate`
# never connects to a database, so a placeholder is enough to satisfy the check; the real
# value is supplied at container runtime via compose and overrides this build-time default.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM node:25-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
# Prisma 7 moved the datasource URL out of schema.prisma's `datasource` block (no more
# `url = env("DATABASE_URL")` there) and into prisma.config.ts's `datasource.url`. `prisma
# migrate deploy` reads the config file, not the schema, for that URL, so prisma.config.ts
# has to ship in the run image too — without it the CLI fails at container start with
# "The datasource.url property is required in your Prisma config file when using prisma
# migrate deploy," even though DATABASE_URL is set correctly in the environment.
COPY --from=build /app/prisma.config.ts ./
# `prisma migrate deploy` at container start needs the full "prisma" CLI. Copying only
# node_modules/prisma + node_modules/@prisma (as CLI docs historically suggest) is not
# enough on Prisma 6.19: the CLI unconditionally loads @prisma/config, which pulls in its
# own real dependencies (effect, c12, deepmerge-ts, empathic) that npm hoists to the
# top-level node_modules rather than nesting under @prisma/config — cherry-picking two
# subfolders leaves those missing ("Cannot find module 'effect'"), and also drops
# node_modules/.bin/prisma so `npx prisma` can't resolve at all ("prisma: not found").
# Copying the full, already-resolved node_modules from the build stage is the reliable
# fix and overlays cleanly onto (a superset of) the standalone trace above.
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
