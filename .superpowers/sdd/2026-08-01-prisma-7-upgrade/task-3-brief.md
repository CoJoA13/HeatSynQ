## Task 3: Verify the production Docker image still builds

The Dockerfile's two Prisma touchpoints both changed meaning in v7 (`prisma generate` now writes to a path that is gitignored; `migrate deploy` now reads its datasource from `prisma.config.ts`). `npm run build` passing locally does not prove the image does.

**Files:**
- Modify (only if the build fails): `erp/Dockerfile`

**Interfaces:**
- Consumes: Task 2's generated-client layout.
- Produces: a proven-good production image path. No source changes if it passes.

- [ ] **Step 1: Build the production image**

```bash
cd erp
docker compose --profile prod build app
```
Expected: succeeds. The build stage runs `npx prisma generate && npm run build && npm prune --omit=dev`.

Two things to watch, both consequences of v7:
- `prisma/generated` is gitignored but **not** dockerignored, and it is produced inside the build stage by `prisma generate`, so it exists before `npm run build` needs it. Confirm the ordering in the Dockerfile is still `generate` **then** `build`.
- `npm prune --omit=dev` must not remove `@prisma/adapter-pg` — it is a runtime dependency and was installed into `dependencies` in Task 2, not `devDependencies`. Verify with `node -p "require('./package.json').dependencies['@prisma/adapter-pg']"` → `7.9.1`.

- [ ] **Step 2: If it failed, fix and re-run; if it passed, do nothing**

Do not "improve" the Dockerfile opportunistically. Its two long comments record hard-won Prisma-6 specifics; if v7 makes one obsolete, update that comment in the same commit rather than deleting it silently.

- [ ] **Step 3: Commit only if the Dockerfile changed**

```bash
git add Dockerfile
git commit -m "$(cat <<'EOF'
fix: adjust the production image for Prisma 7's generated client

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

