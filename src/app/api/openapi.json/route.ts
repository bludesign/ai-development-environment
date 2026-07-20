import { codebasesOpenApiDocument } from "@/services/codebases";
import { telemetryOpenApiDocument } from "@/services/telemetry";

export function GET(): Response {
  return Response.json(
    {
      ...codebasesOpenApiDocument,
      info: {
        title: "AI Development Environment API",
        version: codebasesOpenApiDocument.info.version,
        description: "Public codebase and observability endpoints.",
      },
      tags: [
        ...codebasesOpenApiDocument.tags,
        ...telemetryOpenApiDocument.tags,
      ],
      paths: {
        ...codebasesOpenApiDocument.paths,
        ...telemetryOpenApiDocument.paths,
      },
      components: {
        schemas: {
          ...codebasesOpenApiDocument.components.schemas,
          ...telemetryOpenApiDocument.components.schemas,
        },
        responses: {
          ...codebasesOpenApiDocument.components.responses,
          ...telemetryOpenApiDocument.components.responses,
        },
      },
    },
    {
      headers: { "cache-control": "public, max-age=300" },
    },
  );
}
