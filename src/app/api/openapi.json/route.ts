import { codebasesOpenApiDocument } from "@/services/codebases";

export function GET(): Response {
  return Response.json(codebasesOpenApiDocument, {
    headers: { "cache-control": "public, max-age=300" },
  });
}
