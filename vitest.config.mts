import path from "node:path";
import { fileURLToPath } from "node:url";

import mdx from "@mdx-js/rollup";
import react from "@vitejs/plugin-react";
import remarkGfm from "remark-gfm";
import { defineConfig } from "vitest/config";

// `server-only` throws when loaded outside Next's server export condition. Vitest does not
// emulate that condition, so alias the bare specifier to an empty shim for tests only. The
// real import in src/data/prisma-client.ts stays intact for Next.js builds.
export default defineConfig({
  plugins: [mdx({ remarkPlugins: [remarkGfm] }), react()],
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
