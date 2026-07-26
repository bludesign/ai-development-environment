import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { AgentControlService } from "@/services/agent-control";

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

function unauthorized(message: string): Response {
  return Response.json(
    { error: { code: "TOOL_API_UNAUTHORIZED", message } },
    {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
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
      context: {
        caller: `anonymous@${requestAddress(request)}`,
        correlationId: requestCorrelationId(request),
        source: endpoint,
      },
    };
  }
  const supplied = bearerCredential(request.headers);
  if (!supplied || !equalSecret(supplied, configured)) {
    return { response: unauthorized("A valid bearer token is required") };
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

export function authorizeMcpPresetRequest(
  request: Request,
): { context: ToolInvocationContext } | { response: Response } {
  return authorizeToolRequest(request, "MCP");
}

export async function authorizeRunMcpRequest(
  request: Request,
  agents: AgentControlService,
): Promise<
  { agentId: string; context: ToolInvocationContext } | { response: Response }
> {
  const agentId = await agents.authenticate(bearerCredential(request.headers));
  if (!agentId) {
    return {
      response: unauthorized("A valid enrolled agent credential is required"),
    };
  }
  return {
    agentId,
    context: {
      caller: `agent:${agentId}@${requestAddress(request)}`,
      correlationId: requestCorrelationId(request),
      source: "MCP",
    },
  };
}
