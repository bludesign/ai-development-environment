import { describe, expect, test } from "vitest";

import { compileMcpJsonSchema } from "./mcp-json-schema";

describe("MCP JSON Schema validation", () => {
  test.each([
    undefined,
    "https://json-schema.org/draft/2020-12/schema",
    "https://json-schema.org/draft/2019-09/schema",
  ])("enforces dependentRequired for dialect %s", ($schema) => {
    const validate = compileMcpJsonSchema({
      ...($schema ? { $schema } : {}),
      type: "object",
      properties: { query: { type: "string" }, page: { type: "number" } },
      dependentRequired: { query: ["page"] },
    });
    expect(validate({ query: "example" }).valid).toBe(false);
    expect(validate({ query: "example", page: 1 })).toEqual({ valid: true });
  });

  test("enforces unevaluated properties and prefixItems in draft2020 schemas", () => {
    const validate = compileMcpJsonSchema({
      type: "object",
      allOf: [
        {
          properties: {
            tuple: {
              type: "array",
              prefixItems: [{ type: "string" }, { type: "integer" }],
              items: false,
            },
          },
        },
      ],
      unevaluatedProperties: false,
    });
    expect(validate({ tuple: ["value", 1] }).valid).toBe(true);
    expect(validate({ tuple: [1, "value"] }).valid).toBe(false);
    expect(validate({ tuple: ["value", 1, "extra"] }).valid).toBe(false);
    expect(validate({ extra: true }).valid).toBe(false);
  });

  test.each([
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft-07/schema",
  ])("supports draft7 tuple items and dependencies: %s", ($schema) => {
    const validate = compileMcpJsonSchema({
      $schema,
      type: "object",
      properties: {
        tuple: {
          type: "array",
          items: [{ type: "integer" }, { type: "string" }],
          additionalItems: false,
        },
        query: { type: "string" },
        page: { type: "integer" },
      },
      dependencies: { query: ["page"] },
    });
    expect(
      validate({ tuple: [1, "value"], query: "example", page: 1 }).valid,
    ).toBe(true);
    expect(validate({ tuple: ["value", 1] }).valid).toBe(false);
    expect(validate({ query: "example" }).valid).toBe(false);
  });

  test("preserves schema-valid unions, references, annotations and example data", () => {
    const validate = compileMcpJsonSchema({
      type: "object",
      title: "Lookup",
      description: "Find a record by ID or path",
      $comment: "Standard annotation",
      deprecated: false,
      examples: [{ $schema: "arbitrary example data", $async: true }],
      $defs: { identifier: { type: "string", minLength: 1 } },
      anyOf: [
        {
          properties: { id: { $ref: "#/$defs/identifier" } },
          required: ["id"],
        },
        { properties: { path: { type: "string" } }, required: ["path"] },
      ],
    });
    expect(validate({ id: "id-1" }).valid).toBe(true);
    expect(validate({ path: "/repository" }).valid).toBe(true);
    expect(validate({}).valid).toBe(false);
  });

  test.each([
    { $schema: "https://example.test/unknown-dialect", type: "object" },
    { type: "object", unknownValidationKeyword: true },
    {
      type: "object",
      properties: { item: { unknownValidationKeyword: true } },
    },
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      dependentRequired: { first: ["second"] },
    },
    { type: "object", $ref: "https://example.test/unresolved-schema" },
    { type: "object", $async: true },
    { type: "object", properties: { value: { $async: true } } },
    {
      type: "object",
      properties: {
        value: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "string",
        },
      },
    },
    { type: "object", required: "not-an-array" },
  ])("rejects unverifiable schemas before dispatch: %j", (schema) => {
    expect(() => compileMcpJsonSchema(schema)).toThrow();
  });

  test("compiles input and output schemas independently when upstream repeats an ID", () => {
    const input = compileMcpJsonSchema({
      $id: "https://example.test/tool",
      type: "object",
      required: ["query"],
    });
    const output = compileMcpJsonSchema({
      $id: "https://example.test/tool",
      type: "object",
      required: ["count"],
    });
    expect(input({ query: "example" }).valid).toBe(true);
    expect(output({ query: "example" }).valid).toBe(false);
    expect(output({ count: 1 }).valid).toBe(true);
  });

  test("validates formats without mutating values or inserting defaults", () => {
    const validate = compileMcpJsonSchema({
      type: "object",
      properties: {
        id: { type: "integer" },
        email: { type: "string", format: "email" },
        count: { type: "integer", default: 1 },
      },
      additionalProperties: false,
    });
    const value = { id: "1", email: "invalid", extra: true };
    expect(validate(value).valid).toBe(false);
    expect(value).toEqual({ id: "1", email: "invalid", extra: true });
    const valid = { id: 1, email: "user@example.test" };
    expect(validate(valid).valid).toBe(true);
    expect(valid).not.toHaveProperty("count");
  });
});
