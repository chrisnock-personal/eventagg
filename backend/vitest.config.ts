import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: "./src/test/globalSetup.ts",
    setupFiles: "./src/test/setupFiles.ts",
    // All test files share one real Postgres instance — run them sequentially
    // to avoid cross-file races. Each test still generates random org
    // slugs/keys so data never collides even within a run.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
