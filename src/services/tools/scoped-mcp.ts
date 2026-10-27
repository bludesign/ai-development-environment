import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { mcpScopeMetadata } from "./mcp-permissions";
import type { McpToolSnapshot, McpToolSnapshotEntry } from "./types";

/** JSON Schema is forwarded exactly; remote tools are not approximated as Zod. */
export function createScopedMcpServer(
  snapshot: McpToolSnapshot,
  invoke: (
    tool: McpToolSnapshotEntry,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<CallToolResult>,
): McpServer {
  const server = new McpServer(
    { name: "ai-development-environment", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const byName = new Map(snapshot.tools.map((tool) => [tool.name, tool]));
  if (byName.size !== snapshot.tools.length)
    throw new Error("MCP snapshot contains duplicate tool names");
  server.server.setRequestHandler("tools/list", async () => ({
    tools: snapshot.tools.map(
      ({
        name,
        title,
        description,
        inputSchema,
        outputSchema,
        annotations,
        reference,
      }) => ({
        name,
        _meta: mcpScopeMetadata(
          reference.name,
          reference.source === "EXTERNAL",
        ),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        inputSchema: { type: "object" as const, ...inputSchema },
        ...(outputSchema
          ? { outputSchema: { type: "object" as const, ...outputSchema } }
          : {}),
        ...(annotations ? { annotations } : {}),
      }),
    ),
  }));
  server.server.setRequestHandler("tools/call", async (request, extra) => {
    const tool = byName.get(request.params.name);
    if (!tool)
      return {
        isError: true,
        content: [
          { type: "text", text: "Tool is not included in this MCP scope" },
        ],
      };
    if (request.params.task)
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Task execution is not supported by this MCP scope",
          },
        ],
      };
    try {
      return server.server.projectCallToolResult(
        await invoke(tool, request.params.arguments ?? {}, extra.mcpReq.signal),
        tool.outputSchema ?? undefined,
      );
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : "Tool call failed",
          },
        ],
      };
    }
  });
  return server;
}
