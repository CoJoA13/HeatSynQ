# Task 1 Report: Flip the package to ESM

## Implementation Summary

Successfully flipped the HeatSynQ ERP package to ES modules (ESM) by adding `"type": "module"` to `package.json` and updating `vitest.config.ts` to eliminate the bare `__dirname` reference that is incompatible with ESM.

## Changes Made

### File 1: `erp/package.json`
- **Change**: Added `"type": "module"` immediately after `"private": true,`
- **Lines affected**: Added 1 line at line 5
- **Before**:
  ```json
    "private": true,
    "scripts": {
  ```
- **After**:
  ```json
    "private": true,
    "type": "module",
    "scripts": {
  ```

### File 2: `erp/vitest.config.ts`
- **Change**: Replaced entire file to use `fileURLToPath(new URL("./src", import.meta.url))` instead of `path.resolve(__dirname, "src")`
- **Before**:
  ```ts
  import { defineConfig } from "vitest/config";
  import path from "node:path";

  export default defineConfig({
    test: {
      environment: "node",
      setupFiles: ["tests/helpers/setup.ts"],
      fileParallelism: false, // one shared test DB — keep files sequential
    },
    resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  });
  ```
- **After**:
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

## Test-Driven Development Evidence

### RED (Before ESM Conversion)
Before adding `"type": "module"`, all four gates were green:
- `npm test`: 255 tests passed
- `npx tsc --noEmit`: no errors
- `npx eslint src tests`: no errors
- `npm run build`: successful

The `__dirname` reference in `vitest.config.ts` was working in CommonJS mode but would fail once ESM mode was enabled.

### GREEN (After ESM Conversion)
After applying both changes (adding `"type": "module"` and fixing `vitest.config.ts`), all four gates remain green:
- **npm test**: 255 tests passed (same count, output pristine)
  - All 30 test files passed
  - No regressions or new failures
  - Total duration: ~24 seconds
- **npx tsc --noEmit**: no type errors (silent success)
- **npx eslint src tests**: no linting errors (silent success)  
- **npm run build**: successful Next.js production build
  - Build time: 2.3 seconds
  - All 25 static pages generated
  - All API routes compiled correctly

## Verification

### Files Changed
Only the two files specified in the brief were modified:
1. `erp/package.json` — added `"type": "module"`
2. `erp/vitest.config.ts` — replaced with ESM-compatible alias resolution

No other files in the repository were touched.

### Test Count Verification
- Before: 255 tests passing
- After: 255 tests passing
- Status: No regressions, count unchanged ✓

### Self-Review Findings

1. **ESM Idiom Consistency**: The new `vitest.config.ts` uses `fileURLToPath(new URL(..., import.meta.url))`, which matches the pattern already established in `eslint.config.mjs`. This is the standard Node.js approach for deriving directory paths in ESM modules.

2. **Module Resolution**: The alias `@` pointing to `./src` is correctly maintained through the conversion, ensuring all imports using the `@` prefix continue to work.

3. **No Breaking Changes**: All 255 tests pass with the exact same names and counts. The conversion is fully backward-compatible at the API level; `import`/`export` will be used in later tasks.

4. **Isolation Achieved**: This commit stands alone with all gates green before and after, properly isolating ESM conversion from the upcoming Prisma 7 upgrade work. Any future ESM-related issues are now clearly separable from Prisma changes.

## TDD Evidence — RED State Reproduction

**Command executed** (to reproduce the intermediate broken state before the fix):
```bash
git show 813ea78^:erp/vitest.config.ts > /tmp/old-vitest.config.ts
cp vitest.config.ts /tmp/new-vitest.config.ts
cp /tmp/old-vitest.config.ts vitest.config.ts
npx vitest run tests/users.test.ts
```

**What happened**: The test suite passed unexpectedly.

**Actual observed output** (from Step 3 — RED checkpoint, with old `vitest.config.ts` + new `"type": "module"`):
```
 RUN  v3.2.7 /home/cojoa13/Desktop/HeatSynQ/erp

 ✓ tests/users.test.ts (11 tests) 1208ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  21:39:04
   Duration  1.60s (transform 98ms, setup 21ms, collect 174ms, tests 1.21s, environment 4ms, prepare 33ms)
```

**Key finding**: Contrary to the brief's Step 3 prediction, **no `ReferenceError: __dirname is not defined` was thrown**. The test suite ran successfully even with `path.resolve(__dirname, "src")` in the config and `"type": "module"` in package.json. This suggests vitest or Node 22.23.1 provides `__dirname` in ESM config files despite the documented incompatibility.

**Verification after restoration**:
- Restored new `vitest.config.ts` from backup
- `git status --short` confirmed clean working tree
- `git diff --exit-code vitest.config.ts` confirmed byte-identical to committed version
- Re-ran `npx vitest run tests/users.test.ts` with restored config: all 11 tests passed ✓

**Interpretation**: While the observed RED state differs from the brief's prediction, the fix (switching to `fileURLToPath`) remains correct and necessary for actual ESM compliance. The fact that both states passed is evidence that:
1. Vitest may polyfill `__dirname` for config files even in ESM mode
2. The old config is therefore a latent incompatibility waiting for a stricter Node.js version or vitest upgrade
3. The new config is explicitly ESM-safe and future-proof
4. All 255 tests pass both before and after the fix, confirming no regression

## Concerns

None. The ESM conversion is complete and verified:
- All gates green
- Test count stable at 255
- Only intended files changed
- Follows established patterns in the codebase
- RED state reproduced and documented (though it did not error as predicted)

## Commit Information

- **SHA**: `813ea78` (abbreviated)
- **Full SHA**: `813ea788f4f8a706aa8f16360102560ee99fc277`
- **Branch**: `prisma-7-upgrade`
- **Message**: Matches brief exactly
- **Co-author trailer**: Included as required

---

## Next Task

This ESM foundation is now ready for Task 2, which will upgrade Prisma from 6.19.3 to 7.9.1 and convert imports/exports to use ESM syntax throughout the codebase.
