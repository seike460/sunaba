import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The first test in each file loads aws-cdk-lib and synthesizes a stack;
    // on CI's Node 20 runners that alone took ~5 s, the default timeout.
    testTimeout: 30_000,
  },
});
