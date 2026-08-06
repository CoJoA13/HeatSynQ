## Task 1: Flip the package to ESM

Its own commit, with the full suite green on both sides — handoff §4b's reasoning: if something unrelated breaks, this separation is what makes it findable. **No Prisma changes in this task.**

**Files:**
- Modify: `erp/package.json`
- Modify: `erp/vitest.config.ts:1-11`

**Interfaces:**
- Consumes: nothing.
- Produces: an ESM package. Every later task assumes `import`/`export` only, `import.meta.url` over `__dirname`.

- [ ] **Step 1: Confirm the starting point is green**

```bash
cd erp
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: 255 tests pass; the other three silent. If not, stop — do not start the upgrade on a red tree.

- [ ] **Step 2: Add `"type": "module"`**

In `erp/package.json`, immediately after `"private": true,`:

```json
  "private": true,
  "type": "module",
```

- [ ] **Step 3: Run the suite to see it break**

```bash
npx vitest run tests/users.test.ts
```
Expected: FAIL — `ReferenceError: __dirname is not defined in ES module scope`, thrown from `vitest.config.ts` before any test runs.

- [ ] **Step 4: Fix the one `__dirname` site**

Replace the whole of `erp/vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/helpers/setup.ts"],
    fileParallelism: false, // one shared test DB — keep files sequential
  },
  // `__dirname` does not exist in an ES module; this is the same idiom eslint.config.mjs uses.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
```

- [ ] **Step 5: Run all four gates**

```bash
npm test && npx tsc --noEmit && npx eslint src tests && npm run build
```
Expected: 255 tests pass, all four green.

If `npm run build` fails here, **stop and report before changing anything else** — an ESM failure inside Next is the risk §4b flagged, and it must not get entangled with Prisma changes. `next.config.ts`, `postcss.config.mjs` and `eslint.config.mjs` were each checked and are already ESM-safe, so a failure here is something this plan did not foresee.

- [ ] **Step 6: Commit**

```bash
git add package.json vitest.config.ts
git commit -m "$(cat <<'EOF'
chore: flip the package to ESM ahead of the Prisma 7 upgrade

Prisma 7 ships as an ES module and requires "type": "module". Doing the flip
on its own, with all four gates green either side, keeps unrelated ESM fallout
separable from the Prisma changes (handoff §4b).

vitest.config.ts held the only bare __dirname in the repo; it now derives the
alias from import.meta.url, matching eslint.config.mjs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

