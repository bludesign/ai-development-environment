import { describe, expect, test } from "vitest";

import { codebasesOpenApiDocument } from "./codebases-openapi";

describe("codebases OpenAPI document", () => {
  test("describes both read-only codebase operations and shared schema", () => {
    expect(codebasesOpenApiDocument.openapi).toBe("3.1.0");
    expect(
      codebasesOpenApiDocument.paths["/api/codebases"].get.operationId,
    ).toBe("getCodebases");
    expect(
      codebasesOpenApiDocument.paths["/api/codebases/by-path"].get.operationId,
    ).toBe("getCodebaseByPath");
    expect(
      codebasesOpenApiDocument.components.schemas.CodebaseToolRecord,
    ).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["id", "path", "repository", "agent"]),
    });
  });
});
