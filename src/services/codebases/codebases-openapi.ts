import * as z from "zod/v4";

import { CodebaseToolRecordSchema } from "./codebase-tools.service";

const codebaseSchema = z.toJSONSchema(CodebaseToolRecordSchema);

export const codebasesOpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "AI Development Environment Codebases API",
    version: "0.1.0",
    description: "Read-only access to registered codebase checkouts.",
  },
  tags: [{ name: "Codebases" }],
  paths: {
    "/api/codebases": {
      get: {
        tags: ["Codebases"],
        operationId: "getCodebases",
        summary: "List codebases",
        responses: {
          "200": {
            description: "Registered codebase checkouts",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["codebases"],
                  properties: {
                    codebases: {
                      type: "array",
                      items: {
                        $ref: "#/components/schemas/CodebaseToolRecord",
                      },
                    },
                  },
                },
              },
            },
          },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/codebases/by-path": {
      get: {
        tags: ["Codebases"],
        operationId: "getCodebaseByPath",
        summary: "Get a codebase by folder path",
        parameters: [
          {
            name: "path",
            in: "query",
            required: true,
            description: "Exact absolute folder path of the codebase",
            schema: { type: "string", minLength: 1 },
          },
        ],
        responses: {
          "200": {
            description: "Matching codebase checkout",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["codebase"],
                  properties: {
                    codebase: {
                      $ref: "#/components/schemas/CodebaseToolRecord",
                    },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/AmbiguousPath" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
  },
  components: {
    schemas: {
      CodebaseToolRecord: codebaseSchema,
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              matches: {
                type: "array",
                items: {
                  type: "object",
                  required: ["agentId", "name", "hostname"],
                  properties: {
                    agentId: { type: "string" },
                    name: { type: "string" },
                    hostname: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: Object.fromEntries(
      [
        ["BadRequest", "The path is missing or invalid"],
        ["NotFound", "No codebase uses the requested path"],
        ["AmbiguousPath", "Multiple agents use the requested path"],
        ["InternalError", "Unexpected server error"],
      ].map(([name, description]) => [
        name,
        {
          description,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" },
            },
          },
        },
      ]),
    ),
  },
} as const;
