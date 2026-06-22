import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    isolate: true,
    name: "@paperclipai/desktop",
    include: ["src/__tests__/**/*.test.ts"],
  },
});
