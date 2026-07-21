import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { BuildsService } from "@/services/builds";
import type { CodebaseToolsService } from "@/services/codebases";

import {
  BuiltInToolRegistry,
  createBuiltInToolRegistry,
} from "./builtin-tools";

export function createBuiltInMcpServer(
  registry: BuiltInToolRegistry,
): McpServer {
  const server = new McpServer({
    name: "ai-development-environment",
    version: "0.1.0",
  });

  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: unknown;
      outputSchema: unknown;
      annotations: Record<string, boolean>;
    },
    handler: (input: unknown) => ReturnType<BuiltInToolRegistry["callByName"]>,
  ) => void;

  for (const tool of registry.definitions()) {
    registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (input) => registry.callByName(tool.name, input),
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
