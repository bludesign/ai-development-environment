import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { getServerServices } from "@/services/server-services";
import {
  authorizeMcpPresetRequest,
  authorizeRunMcpRequest,
  authorizeToolRequest,
  createBuiltInMcpServer,
} from "@/services/tools";
import type { ToolInvocationContext } from "@/services/tools";

export const runtime = "nodejs";
export const maxDuration = 180;

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const presetValues = url.searchParams.getAll("preset");
  const runValues = url.searchParams.getAll("run");
  if (
    presetValues.length > 1 ||
    runValues.length > 1 ||
    (presetValues.length && runValues.length)
  ) {
    return Response.json(
      { error: { code: "INVALID_MCP_SCOPE", message: "Choose one MCP scope" } },
      { status: 400 },
    );
  }

  const services = getServerServices();
  const tools = services.toolsService;
  let context: ToolInvocationContext;
  let allowedToolNames: ReadonlySet<string> | undefined;
  if (runValues.length) {
    const runId = runValues[0]!.trim();
    if (!runId) {
      return Response.json(
        { error: { code: "INVALID_MCP_SCOPE", message: "Run id is required" } },
        { status: 400 },
      );
    }
    const authorization = await authorizeRunMcpRequest(
      request,
      services.agentControlService,
    );
    if ("response" in authorization) return authorization.response;
    const snapshot = await tools.mcpRunToolNames(runId, authorization.agentId);
    if (snapshot.status === "NOT_FOUND") {
      return Response.json(
        { error: { code: "RUN_NOT_FOUND", message: "Run not found" } },
        { status: 404 },
      );
    }
    if (snapshot.status === "FORBIDDEN") {
      return Response.json(
        {
          error: {
            code: "RUN_MCP_FORBIDDEN",
            message: "Run belongs to another agent",
          },
        },
        { status: 403 },
      );
    }
    context = authorization.context;
    allowedToolNames = new Set(snapshot.toolNames);
  } else if (presetValues.length) {
    const presetId = presetValues[0]!.trim();
    if (!presetId) {
      return Response.json(
        {
          error: {
            code: "INVALID_MCP_SCOPE",
            message: "Preset id is required",
          },
        },
        { status: 400 },
      );
    }
    const authorization = authorizeMcpPresetRequest(request);
    if ("response" in authorization) return authorization.response;
    const toolNames = await tools.mcpPresetToolNames(presetId);
    if (!toolNames) {
      return Response.json(
        {
          error: {
            code: "MCP_PRESET_NOT_FOUND",
            message: "MCP tool preset not found",
          },
        },
        { status: 404 },
      );
    }
    context = authorization.context;
    allowedToolNames = new Set(toolNames);
  } else {
    const authorization = authorizeToolRequest(request, "MCP");
    if ("response" in authorization) return authorization.response;
    context = authorization.context;
  }
  try {
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = createBuiltInMcpServer(
      tools.builtInTools,
      (name, input) => tools.callBuiltInTool(name, input, context),
      allowedToolNames,
    );
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    response.headers.set("x-request-id", context.correlationId);
    return response;
  } catch (error) {
    console.error("MCP request failed:", error);
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
