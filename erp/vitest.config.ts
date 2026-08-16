import { defineConfig, configDefaults } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/helpers/setup.ts"],
    fileParallelism: false, // one shared test DB — keep files sequential
    // Every test lives in tests/ — scoping collection there keeps `next build`'s standalone copy of
    // the whole project (.next/standalone/<repo path>/tests/**) out of the run. Without this the
    // suite collected each file TWICE after a build (measured: 358 files for 179 real ones), so gate
    // ORDER silently mattered and any post-build count was inflated. `.next` is a dot-directory and
    // vitest matches with `dot: true`, which is what made it reachable at all. The exclude is
    // defense in depth for anyone who later widens the include; it spreads vitest's own defaults
    // because `exclude` REPLACES them rather than merging. (#122)
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: [...configDefaults.exclude, "**/.next/**"],
  },
  // `__dirname` does not exist in an ES module; this is the same idiom eslint.config.mjs uses.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
