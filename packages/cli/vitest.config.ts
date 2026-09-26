import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Tests must run on a clean checkout — don't require sdk's dist/.
      "sunaba-sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)),
    },
  },
});
