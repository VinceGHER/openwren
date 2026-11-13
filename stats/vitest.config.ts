import { defineConfig } from "vitest/config";

// Its own config, so vitest does not pick up the app's vite.config.ts in the parent folder.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
