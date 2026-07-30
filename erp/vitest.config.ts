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
