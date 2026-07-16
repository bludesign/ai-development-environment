import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  GetCodebaseInputSchema,
  GetCodebaseOutputSchema,
  GetCodebasesInputSchema,
  GetCodebasesOutputSchema,
  type CodebaseToolsService,
} from "@/services/codebases";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function result(structuredContent: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

export function createCodebasesMcpServer(
  codebaseTools: CodebaseToolsService,
): McpServer {
  const server = new McpServer({
    name: "ai-development-environment",
    version: "0.1.0",
  });

  server.registerTool(
    "get_codebases",
    {
      title: "Get codebases",
      description:
        "List basic information for every registered codebase checkout.",
      inputSchema: GetCodebasesInputSchema,
      outputSchema: GetCodebasesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const structuredContent = GetCodebasesOutputSchema.parse({
        codebases: await codebaseTools.list(),
      });
      return result(structuredContent);
    },
  );

  server.registerTool(
    "get_codebase",
    {
      title: "Get codebase",
      description:
        "Get one registered codebase checkout by its exact folder path.",
      inputSchema: GetCodebaseInputSchema,
      outputSchema: GetCodebaseOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ path }) => {
      const structuredContent = GetCodebaseOutputSchema.parse({
        codebase: await codebaseTools.getByPath(path),
      });
      return result(structuredContent);
    },
  );

  return server;
}
