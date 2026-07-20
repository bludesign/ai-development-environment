import { codebasesOpenApiDocument } from "@/services/codebases";
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
          "Public codebase, observability, and APNs device-registration endpoints.",
      },
      tags: [
        ...codebasesOpenApiDocument.tags,
        ...telemetryOpenApiDocument.tags,
        ...pushNotificationsOpenApiDocument.tags,
      ],
      paths: {
        ...codebasesOpenApiDocument.paths,
        ...telemetryOpenApiDocument.paths,
        ...pushNotificationsOpenApiDocument.paths,
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
      },
    },
    {
      headers: { "cache-control": "public, max-age=300" },
    },
  );
}
