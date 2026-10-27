import { McpServer } from "@modelcontextprotocol/server";

import { mcpScopeMetadata } from "./mcp-permissions";

import type { BuildsService } from "@/services/builds";
import type { CodebaseToolsService } from "@/services/codebases";

import {
  BuiltInToolRegistry,
  createBuiltInToolRegistry,
} from "./builtin-tools";

export function createBuiltInMcpServer(
  registry: BuiltInToolRegistry,
  invoke: (
    name: string,
    input: unknown,
  ) => ReturnType<BuiltInToolRegistry["callByName"]> = (name, input) =>
    registry.callByName(name, input),
  allowedToolNames?: ReadonlySet<string>,
): McpServer {
  const server = new McpServer({
    name: "ai-development-environment",
    version: "0.1.0",
  });

  for (const tool of registry.definitions()) {
    if (allowedToolNames && !allowedToolNames.has(tool.name)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        _meta: mcpScopeMetadata(tool.name),
      },
      async (input) => invoke(tool.name, input),
    );
  }

  return server;
}

/**
 * Backward-compatible factory for callers that only provide the original
 * Codebases and optional Builds services.
 */
export function createCodebasesMcpServer(
  codebaseTools: CodebaseToolsService,
  builds?: BuildsService,
): McpServer {
  return createBuiltInMcpServer(
    createBuiltInToolRegistry({ codebaseTools, builds }),
  );
}
