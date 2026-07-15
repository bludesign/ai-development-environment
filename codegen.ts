import type { CodegenConfig } from "@graphql-codegen/cli";

// SDL-first: resolver types are generated from the subgraph SDL in schemas/. Kept minimal
// while the domain is empty — add `documents` and the `client` preset here once the frontend
// starts issuing typed GraphQL operations.
const config: CodegenConfig = {
  overwrite: true,
  schema: "./schemas/**/*.graphql",
  generates: {
    "src/generated/resolvers.ts": {
      plugins: ["typescript", "typescript-resolvers"],
      config: {
        federation: true,
        useIndexSignature: true,
      },
    },
  },
};

export default config;
