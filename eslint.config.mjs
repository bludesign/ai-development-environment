import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-mock/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated code (Prisma client, GraphQL resolver types, bundled SDL).
    "src/generated/**",
    "packages/*/dist/**",
    // npm publish staging output (assembled by scripts/prepare-npm-server-package.mjs).
    ".npm-staging/**",
  ]),
  // An underscore prefix is the codebase's marker for "deliberately unused": resolver roots,
  // event handler args, mocks, discarded destructured fields, and ignored catch bindings.
  // Severity stays at eslint-config-next's `warn`; only the ignore patterns are added.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  // CommonJS launcher scripts shipped inside the npm server package.
  {
    files: ["scripts/npm/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
