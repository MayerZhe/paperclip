import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";

export default defineConfig({
  cacheDir: path.join(os.tmpdir(), "vitest-cache-desktop"),
  test: {
    environment: "node",
    isolate: true,
  },
});
