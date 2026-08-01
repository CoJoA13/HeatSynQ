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
