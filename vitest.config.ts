import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Tests that write a design's history to git can take several seconds
    // on a busy computer, such as the live app's own while it deploys.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
