import path from "node:path";
import { fileURLToPath } from "node:url";

import mdx from "@mdx-js/rollup";
import react from "@vitejs/plugin-react";
import remarkGfm from "remark-gfm";
import { configDefaults, defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const sharedTestExcludes = [
  ...configDefaults.exclude,
  "packages/control-agent/**",
  // Playwright owns everything under playwright/ (see testDir in playwright.config.ts).
  // Its specs match Vitest's default `*.spec.ts` include, and loading them here makes
  // test.describe() throw because Playwright's runner isn't the one executing them.
  "playwright/**",
  ".next/**",
  // Screenshot builds copy source tests into this generated tree. Running them again
  // makes local results depend on stale build output and duplicates those test files.
  ".next-mock/**",
  ".npm-staging/**",
];
const componentNodeTestIncludes = [
  "src/components/agents/capability-payloads.test.ts",
  "src/components/apps/app-summary-subscriptions.test.ts",
  "src/components/auth/auth-form.test.ts",
  "src/components/common/diff-view/parse-patch.test.ts",
  "src/components/disk-space/types.test.ts",
  "src/components/github/workflow-resource-context.test.ts",
  "src/components/jira/description-history.test.ts",
  "src/components/push-notifications/push-notifications-page.test.ts",
  "src/components/signing-assets/apple-portal.test.ts",
  "src/components/tools/mcp-preset-management.test.ts",
  "src/components/usage/aggregate-usage.test.ts",
  "src/components/usage/usage-cost-chart.test.ts",
  "src/components/workflows/basic-layout.test.ts",
  "src/components/workflows/config-fields/condition.test.ts",
  "src/components/workflows/workflow-graph.test.ts",
];

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
    //
    // APP_SECRET is required in every environment, tests included, so the suite
    // supplies a fixed one. It is deliberately constant: credential fixtures are
    // encrypted with a key derived from it, and a per-run value would make their
    // stored key fingerprints unstable.
    env: {
      TZ: "America/New_York",
      APP_SECRET: "zhDyTms26c9u15SUcFxkhS8S+dCRnouxjPbQMb/haB8=",
    },
    // The GitHub runners are slow enough that tests which finish in well under a
    // second locally were tripping Vitest's 5s default and failing the workflow.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: sharedTestExcludes,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: configDefaults.include,
          exclude: [
            ...sharedTestExcludes,
            "src/components/**",
            "src/app/**/*.test.tsx",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "component-node",
          environment: "node",
          pool: "threads",
          include: componentNodeTestIncludes,
          exclude: sharedTestExcludes,
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          pool: "threads",
          include: [
            "src/components/**/*.test.{ts,tsx}",
            "src/app/**/*.test.tsx",
          ],
          exclude: [...sharedTestExcludes, ...componentNodeTestIncludes],
        },
      },
    ],
    coverage: {
      provider: "v8",
      // `coverage/` is gitignored and cleared by `npm run clean`.
      reportsDirectory: "./coverage",
      // `lcov` writes lcov.info for editors and CI; `json` writes
      // coverage-final.json with the per-line hit counts a coverage viewer
      // needs; `json-summary` writes the totals; `html` is the local report.
      reporter: ["text", "html", "lcov", "json", "json-summary"],
      // Vitest only reports on files a test imported unless `include` names
      // them, which would hide never-tested files behind a flattering number.
      include: [
        "src/**/*.{ts,tsx}",
        "scripts/**/*.{ts,mts,mjs}",
        // Imported by the app under test; the control agent workspace is
        // measured by `npm run agent:test:run` instead.
        "packages/agent-contract/src/**/*.ts",
      ],
      exclude: [
        // Generated by `npm run generate` — nothing here is hand-written.
        "src/generated/**",
        "src/**/__mocks__/**",
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        // Fixture data for the mock database and the Playwright captures.
        "scripts/mock-data/**",
        "packages/control-agent/**",
        // Build output copies of src/, which would otherwise show up as a
        // second, stale entry for every file the mock build bundled.
        ".next/**",
        ".next-mock/**",
      ],
      // Coverage of the tests that did run is still the fastest way to see why
      // the others failed.
      reportOnFailure: true,
    },
  },
});
