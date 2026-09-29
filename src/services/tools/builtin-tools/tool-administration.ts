import * as z from "zod/v4";
import { BUILD_CONFIGURATION_ICON_KEYS } from "@ai-development-environment/agent-contract/builds";

import type { ToolCallAuditService } from "../tool-call-audit.service";
import {
  READ_ONLY_EXTERNAL_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { serviceTool } from "./service-tool";

const McpPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  iconKey: z.enum(BUILD_CONFIGURATION_ICON_KEYS),
  enabledForPlans: z.boolean(),
  enabledForSessions: z.boolean(),
  toolNames: z.array(z.string()),
  tools: z.array(
    z.discriminatedUnion("source", [
      z.object({ source: z.literal("BUILTIN"), name: z.string() }),
      z.object({
        source: z.literal("EXTERNAL"),
        name: z.string(),
        serverId: z.string(),
        serverName: z.string().nullable().optional(),
      }),
    ]),
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function createToolAdministrationGroup(
  audit: ToolCallAuditService,
  testExternalServer: (id: string) => Promise<unknown>,
  listMcpToolPresets?: (kind?: "PLAN" | "SESSION") => Promise<unknown>,
): BuiltInToolGroup {
  return {
    id: "builtin:tool-administration",
    name: "Tool Administration",
    children: [],
    tools: [
      ...(listMcpToolPresets
        ? [
            defineTool({
              name: "get_mcp_tool_presets",
              title: "Get MCP tool presets",
              description:
                "List saved MCP presets with local IDs, descriptions, enabled run kinds, and built-in or external tool selections. Pass selected IDs as mcpPresetIds when creating a run or playing a plan.",
              inputSchema: z.object({
                kind: z.enum(["PLAN", "SESSION"]).optional(),
              }),
              outputSchema: z.object({ presets: z.array(McpPresetSchema) }),
              handler: async ({ kind }) => ({
                presets: await listMcpToolPresets(kind),
              }),
            }),
          ]
        : []),
      serviceTool({
        name: "test_external_mcp_server",
        title: "Test external MCP server",
        description:
          "Connect to a configured external MCP server and report its tool count without returning saved headers.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service: { testExternalServer },
        method: "testExternalServer",
        arguments: ({ id }) => [id],
        resultKey: "status",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_tool_call_history",
        title: "Get tool call history",
        description:
          "List redacted tool-call audit records. Arguments are represented only by SHA-256 hashes.",
        inputSchema: z.object({
          first: z.number().int().min(1).max(500).default(100),
          toolName: z.string().nullable().optional(),
          resultStatus: z
            .enum(["RUNNING", "SUCCEEDED", "FAILED"])
            .nullable()
            .optional(),
        }),
        service: audit,
        method: "list",
        resultKey: "calls",
      }),
      serviceTool({
        name: "get_tool_call",
        title: "Get tool call",
        description: "Get one redacted tool-call audit record by ID.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service: audit,
        method: "get",
        arguments: ({ id }) => [id],
        resultKey: "call",
      }),
    ],
  };
}
