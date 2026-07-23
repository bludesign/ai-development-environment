import path from "node:path";
import { fileURLToPath } from "node:url";

import mdx from "@mdx-js/rollup";
import react from "@vitejs/plugin-react";
import remarkGfm from "remark-gfm";
import { configDefaults, defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

// `server-only` throws when loaded outside Next's server export condition. Vitest does not
// emulate that condition, so alias the bare specifier to an empty shim for tests only. The
// real import in src/data/prisma-client.ts stays intact for Next.js builds.
export default defineConfig({
  plugins: [mdx({ remarkPlugins: [remarkGfm] }), react()],
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: "server-only",
        replacement: path.resolve(rootDirectory, "test/mocks/server-only.ts"),
      },
      {
        find: /^.+\.svg$/,
        replacement: path.resolve(
          rootDirectory,
          "test/mocks/svg-component.tsx",
        ),
      },
      {
        find: /^next-intl$/,
        replacement: path.resolve(rootDirectory, "src/__mocks__/next-intl.js"),
      },
      {
        find: /^next-intl\/server$/,
        replacement: path.resolve(
          rootDirectory,
          "src/__mocks__/next-intl-server.js",
        ),
      },
      {
        find: /^next-intl\/navigation$/,
        replacement: path.resolve(rootDirectory, "src/__mocks__/next-intl.js"),
      },
      {
        find: /^next-intl\/routing$/,
        replacement: path.resolve(rootDirectory, "src/__mocks__/next-intl.js"),
      },
    ],
  },
  test: {
    // Date tests assert that a zoneless format differs from the UTC one, so the run
    // needs a fixed non-UTC zone. CI machines default to UTC, which makes those
    // assertions vacuously equal.
    env: { TZ: "America/New_York" },
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "packages/control-agent/**"],
  },
});
