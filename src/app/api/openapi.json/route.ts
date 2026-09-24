import { codebasesOpenApiDocument } from "@/services/codebases";
import { crashesOpenApiDocument } from "@/services/crashes/crashes-openapi";
import { telemetryOpenApiDocument } from "@/services/telemetry";
import { pushNotificationsOpenApiDocument } from "@/services/push-notifications";

export function GET(): Response {
  return Response.json(
    {
      ...codebasesOpenApiDocument,
      info: {
        title: "AI Development Environment API",
        version: codebasesOpenApiDocument.info.version,
        description:
          "Authenticated codebase endpoints, public observability and APNs integration endpoints, and crash report and dSYM uploads.",
      },
      tags: [
        ...codebasesOpenApiDocument.tags,
        ...telemetryOpenApiDocument.tags,
        ...pushNotificationsOpenApiDocument.tags,
        ...crashesOpenApiDocument.tags,
      ],
      paths: {
        ...codebasesOpenApiDocument.paths,
        ...telemetryOpenApiDocument.paths,
        ...pushNotificationsOpenApiDocument.paths,
        ...crashesOpenApiDocument.paths,
      },
      components: {
        schemas: {
          ...codebasesOpenApiDocument.components.schemas,
          ...telemetryOpenApiDocument.components.schemas,
          ...pushNotificationsOpenApiDocument.components.schemas,
        },
        responses: {
          ...codebasesOpenApiDocument.components.responses,
          ...telemetryOpenApiDocument.components.responses,
        },
        securitySchemes: {
          ...codebasesOpenApiDocument.components.securitySchemes,
          ...crashesOpenApiDocument.components.securitySchemes,
        },
      },
    },
    {
      headers: { "cache-control": "public, max-age=300" },
    },
  );
}
