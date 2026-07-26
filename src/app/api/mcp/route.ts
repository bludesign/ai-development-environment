import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { getServerServices } from "@/services/server-services";
import { authorizeToolRequest, createBuiltInMcpServer } from "@/services/tools";

export const runtime = "nodejs";
export const maxDuration = 180;

async function handle(request: Request): Promise<Response> {
  const authorization = authorizeToolRequest(request, "MCP");
  if ("response" in authorization) return authorization.response;
  try {
    const transport = new WebStandardStreamableHTTPServerTransport();
    const tools = getServerServices().toolsService;
    const server = createBuiltInMcpServer(tools.builtInTools, (name, input) =>
      tools.callBuiltInTool(name, input, authorization.context),
    );
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    response.headers.set("x-request-id", authorization.context.correlationId);
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
