// @vitest-environment node
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  collectGraphQLFiles,
  findUndocumentedSchemaElements,
  formatUndocumentedSchemaElements,
} from "./graphql-schema-utils.mjs";

describe("GraphQL schema documentation", () => {
  test("documents every introspectable source-schema element", async () => {
    const files = await collectGraphQLFiles(resolve(process.cwd(), "schemas"));
    const missing = files.flatMap(({ relativePath, source }) =>
      findUndocumentedSchemaElements(source, relativePath),
    );

    expect(missing, formatUndocumentedSchemaElements(missing)).toEqual([]);
  });

  test("reports actionable paths and lines for missing descriptions", () => {
    const missing = findUndocumentedSchemaElements(
      `"A documented type."
      type Example {
        item(
          id: ID!
        ): String!
      }

      enum State {
        READY
      }`,
      "fixture.graphql",
    );

    expect(missing).toEqual([
      {
        file: "fixture.graphql",
        line: 3,
        path: "Example.item",
        kind: "field",
      },
      {
        file: "fixture.graphql",
        line: 4,
        path: "Example.item(id)",
        kind: "argument",
      },
      {
        file: "fixture.graphql",
        line: 8,
        path: "State",
        kind: "definition",
      },
      {
        file: "fixture.graphql",
        line: 9,
        path: "State.READY",
        kind: "enum value",
      },
    ]);
    expect(formatUndocumentedSchemaElements(missing)).toContain(
      "fixture.graphql:4 Example.item(id)",
    );
  });

  test("checks extension fields without requiring an extension description", () => {
    const missing = findUndocumentedSchemaElements(`
      extend type Query {
        undocumented: String!
      }
    `);

    expect(missing.map(({ path }) => path)).toEqual(["Query.undocumented"]);
  });
});
