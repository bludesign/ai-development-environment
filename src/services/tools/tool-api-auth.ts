import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { ToolInvocationContext } from "./tool-call-audit.service";

type ToolEndpoint = "MCP" | "TOOLS_PAGE";

function bearerCredential(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim() || null;
}

function equalSecret(first: string, second: string): boolean {
  const left = Buffer.from(first);
  const right = Buffer.from(second);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestCorrelationId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && supplied.length <= 128 ? supplied : randomUUID();
}

function requestAddress(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function unauthorized(status: 401 | 503, message: string): Response {
  return Response.json(
    { error: { code: "TOOL_API_UNAUTHORIZED", message } },
    {
      status,
      headers: status === 401 ? { "www-authenticate": "Bearer" } : undefined,
    },
  );
}

export function authorizeToolRequest(
  request: Request,
  endpoint: ToolEndpoint,
): { context: ToolInvocationContext } | { response: Response } {
  const configured = process.env.TOOLS_API_TOKEN?.trim();
  if (!configured) {
    return {
      response: unauthorized(
        503,
        "Tool API access is disabled until TOOLS_API_TOKEN is configured",
      ),
    };
  }
  const supplied = bearerCredential(request.headers);
  if (!supplied || !equalSecret(supplied, configured)) {
    return { response: unauthorized(401, "A valid bearer token is required") };
  }
  const fingerprint = createHash("sha256")
    .update(supplied)
    .digest("hex")
    .slice(0, 12);
  return {
    context: {
      caller: `bearer:${fingerprint}@${requestAddress(request)}`,
      correlationId: requestCorrelationId(request),
      source: endpoint,
    },
  };
}
