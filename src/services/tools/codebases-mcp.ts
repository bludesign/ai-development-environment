import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { mcpScopeMetadata, type McpSecurityScheme } from "./mcp-permissions";

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
  authentication: McpSecurityScheme = "oauth2",
): McpServer {
  const server = new McpServer(
    { name: "ai-development-environment", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const definitions = registry
    .definitions()
    .filter((tool) => !allowedToolNames || allowedToolNames.has(tool.name));

  for (const tool of definitions) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        _meta: mcpScopeMetadata(tool.name, false, authentication),
      },
      async (input) => invoke(tool.name, input),
    );
  }

  // The SDK's registerTool only forwards _meta. Publish the top-level auth
  // declaration too, while retaining SDK validation and dispatch for tools/call.
  server.server.setRequestHandler("tools/list", async () => ({
    tools: definitions.map((tool) => {
      const metadata = mcpScopeMetadata(tool.name, false, authentication);
      return {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: {
          type: "object" as const,
          ...(z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<
            string,
            unknown
          >),
        },
        outputSchema: z.toJSONSchema(tool.outputSchema) as Record<
          string,
          unknown
        >,
        annotations: tool.annotations,
        securitySchemes: metadata.securitySchemes,
        _meta: metadata,
      };
    }),
  }));

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
