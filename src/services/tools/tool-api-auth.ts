import "server-only";

import { randomUUID } from "node:crypto";

import type { AgentControlService } from "@/services/agent-control";
import {
  PrincipalResolutionError,
  resolveRequestPrincipal,
} from "@/services/auth";

import type { ToolInvocationContext } from "./tool-call-audit.service";

type ToolEndpoint = "MCP" | "TOOLS_PAGE";

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

export async function authorizeToolRequest(
  request: Request,
  endpoint: ToolEndpoint,
): Promise<{ context: ToolInvocationContext } | { response: Response }> {
  try {
    const principal = await resolveRequestPrincipal(request.headers);
    if (
      principal.kind !== "user" &&
      !(endpoint === "MCP" && principal.kind === "apiKey")
    ) {
      return {
        response: unauthorized(
          endpoint === "TOOLS_PAGE"
            ? "A user session is required"
            : "A user session or X-API-Key is required",
        ),
      };
    }
    const caller =
      principal.kind === "user"
        ? `user:${principal.userId}`
        : `api-key:${principal.apiKeyId}`;
    return {
      context: {
        caller: `${caller}@${requestAddress(request)}`,
        correlationId: requestCorrelationId(request),
        source: endpoint,
      },
    };
  } catch (error) {
    if (error instanceof PrincipalResolutionError) {
      return { response: unauthorized(error.message) };
    }
    throw error;
  }
}

export async function authorizeMcpPresetRequest(
  request: Request,
): Promise<{ context: ToolInvocationContext } | { response: Response }> {
  return authorizeToolRequest(request, "MCP");
}

export async function authorizeRunMcpRequest(
  request: Request,
  agents: AgentControlService,
): Promise<
  { agentId: string; context: ToolInvocationContext } | { response: Response }
> {
  try {
    const principal = await resolveRequestPrincipal(request.headers, agents);
    if (principal.kind !== "agent") {
      return {
        response: unauthorized("A valid enrolled agent credential is required"),
      };
    }
    return {
      agentId: principal.agentId,
      context: {
        caller: `agent:${principal.agentId}@${requestAddress(request)}`,
        correlationId: requestCorrelationId(request),
        source: "MCP",
      },
    };
  } catch (error) {
    if (error instanceof PrincipalResolutionError) {
      return { response: unauthorized(error.message) };
    }
    throw error;
  }
}
