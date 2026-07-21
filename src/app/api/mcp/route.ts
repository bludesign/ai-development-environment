import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { getServerServices } from "@/services/server-services";
import { createBuiltInMcpServer } from "@/services/tools";

export const runtime = "nodejs";
export const maxDuration = 180;

async function handle(request: Request): Promise<Response> {
  try {
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = createBuiltInMcpServer(
      getServerServices().toolsService.builtInTools,
    );
    await server.connect(transport);
    return await transport.handleRequest(request);
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
