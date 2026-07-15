import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `server-only` throws when loaded outside Next's server export condition. Vitest does not
// emulate that condition, so alias the bare specifier to an empty shim for tests only. The
// real import in src/data/prisma-client.ts stays intact for Next.js builds.
export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      "server-only": path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "test/mocks/server-only.ts",
      ),
    },
  },
  test: {
    environment: "jsdom",
  },
});
