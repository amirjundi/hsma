import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scoped to this package. Without a root, vitest walks the whole 34k-file
    // monorepo looking for tests and never finishes.
    root: import.meta.dirname,
    include: ["test/**/*.test.ts"],
  },
});
