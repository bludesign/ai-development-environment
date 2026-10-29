import * as z from "zod/v4";
import { BUILD_CONFIGURATION_ICON_KEYS } from "@ai-development-environment/agent-contract/builds";

import type { ToolCallAuditService } from "../tool-call-audit.service";
import type { ToolsService } from "../tools.service";
import type { McpPresetTransferService } from "../mcp-preset-transfer.service";
import {
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_EXTERNAL_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { serviceTool } from "./service-tool";

export type ToolAdministrationCallbacks = Pick<
  ToolsService,
  | "createMcpToolPreset"
  | "updateMcpToolPreset"
  | "deleteMcpToolPreset"
  | "externalServers"
  | "createExternalServer"
  | "updateExternalServer"
  | "deleteExternalServer"
  | "clearToolCallAudits"
> & {
  exportCatalog: McpPresetTransferService["exportCatalog"];
  exportPresets: McpPresetTransferService["exportPresets"];
  previewPresetImport: McpPresetTransferService["preview"];
  importPresets: McpPresetTransferService["import"];
};

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
  administration?: ToolAdministrationCallbacks,
): BuiltInToolGroup {
  return {
    id: "builtin:tool-administration",
    name: "Tool Administration",
    children: [],
    tools: [
      ...(administration ? createAdministrationTools(administration) : []),
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

const identifier = z.string().trim().min(1).max(500);
const presetInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).nullable().optional(),
  iconKey: z.enum(BUILD_CONFIGURATION_ICON_KEYS),
  enabledForPlans: z.boolean(),
  enabledForSessions: z.boolean(),
  toolNames: z.array(identifier).max(2000).nullable().optional(),
  tools: z
    .array(
      z.discriminatedUnion("source", [
        z.object({ source: z.literal("BUILTIN"), name: identifier }),
        z.object({
          source: z.literal("EXTERNAL"),
          name: identifier,
          serverId: identifier,
          serverName: identifier.nullable().optional(),
        }),
      ]),
    )
    .max(2000)
    .nullable()
    .optional(),
});
const importInput = z.object({
  document: z.string().min(1).max(5_000_000),
  decisions: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        action: z.enum(["CREATE", "REPLACE", "SKIP"]),
        name: identifier.nullable().optional(),
        targetId: identifier.nullable().optional(),
      }),
    )
    .max(500)
    .nullable()
    .optional(),
  serverMappings: z
    .array(z.object({ serverKey: identifier, serverId: identifier }))
    .max(500)
    .nullable()
    .optional(),
});
const externalInput = z.object({
  name: z.string().trim().min(1).max(200),
  url: z.url().max(2000),
  transport: z.enum(["STREAMABLE_HTTP", "SSE"]),
  toolNamePrefix: z.string().max(100).nullable().optional(),
  // Existing header IDs retain stored values. New secret values belong in settings.
  headers: z
    .array(z.object({ id: identifier, name: identifier }))
    .max(100)
    .default([]),
});

function createAdministrationTools(service: ToolAdministrationCallbacks) {
  const externalUpdates = {
    updateExternalServer: async (
      id: string,
      input: Omit<
        Parameters<ToolAdministrationCallbacks["updateExternalServer"]>[1],
        "headers"
      > & { headers?: Array<{ id: string; name: string }> },
    ) => {
      if (input.headers)
        return service.updateExternalServer(id, {
          ...input,
          headers: input.headers,
        });
      const existing = (await service.externalServers()).find(
        (server) => server.id === id,
      );
      if (!existing) throw new Error("External MCP server not found");
      return service.updateExternalServer(id, {
        ...input,
        headers: existing.headers.map(({ id, name }) => ({ id, name })),
      });
    },
  };
  return [
    serviceTool({
      name: "create_mcp_tool_preset",
      title: "Create MCP tool preset",
      description:
        "Create an explicit preset of selected built-in and external tools.",
      inputSchema: z.object({ input: presetInput }),
      service,
      method: "createMcpToolPreset",
      arguments: ({ input }) => [input],
      resultKey: "preset",
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
    }),
    serviceTool({
      name: "update_mcp_tool_preset",
      title: "Update MCP tool preset",
      description:
        "Replace a saved MCP preset's settings and explicit tool selection.",
      inputSchema: z.object({ id: identifier, input: presetInput }),
      service,
      method: "updateMcpToolPreset",
      arguments: ({ id, input }) => [id, input],
      resultKey: "preset",
      annotations: WRITE_ANNOTATIONS,
    }),
    serviceTool({
      name: "delete_mcp_tool_preset",
      title: "Delete MCP tool preset",
      description:
        "Delete a saved MCP preset without changing frozen selections on existing runs.",
      inputSchema: z.object({ id: identifier }),
      service,
      method: "deleteMcpToolPreset",
      arguments: ({ id }) => [id],
      resultKey: "deleted",
      annotations: DESTRUCTIVE_ANNOTATIONS,
    }),
    serviceTool({
      name: "export_mcp_tool_catalog",
      title: "Export MCP tool catalog",
      description:
        "Export the discovered tool catalog as JSON or Markdown without saved credentials.",
      inputSchema: z.object({
        format: z.enum(["JSON", "MARKDOWN"]),
        source: z.enum(["ALL", "BUILTIN", "EXTERNAL"]).default("ALL"),
        groupIds: z.array(identifier).max(500).nullable().optional(),
      }),
      service,
      method: "exportCatalog",
      arguments: ({ format, source, groupIds }) => [format, source, groupIds],
      resultKey: "document",
      annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
    }),
    serviceTool({
      name: "export_mcp_tool_presets",
      title: "Export MCP tool presets",
      description:
        "Export selected presets with portable built-in and external tool identities.",
      inputSchema: z.object({ ids: z.array(identifier).min(1).max(500) }),
      service,
      method: "exportPresets",
      arguments: ({ ids }) => [ids],
      resultKey: "document",
    }),
    serviceTool({
      name: "preview_mcp_tool_preset_import",
      title: "Preview MCP tool preset import",
      description:
        "Validate preset import decisions and server mappings; returns the review token required for import.",
      inputSchema: z.object({ input: importInput }),
      service,
      method: "previewPresetImport",
      arguments: ({ input }) => [input],
      resultKey: "preview",
      mapResult: (value) => value,
    }),
    serviceTool({
      name: "import_mcp_tool_presets",
      title: "Import MCP tool presets",
      description:
        "Apply the exact reviewed preset import. The preview token must match the input and current server mappings.",
      inputSchema: z.object({
        input: importInput,
        previewToken: z.string().min(1).max(2000),
      }),
      service,
      method: "importPresets",
      arguments: ({ input, previewToken }) => [input, previewToken],
      resultKey: "result",
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
    }),
    serviceTool({
      name: "get_external_mcp_servers",
      title: "Get external MCP servers",
      description:
        "List configured external servers and header names/configuration status, excluding header values.",
      inputSchema: z.object({}),
      service,
      method: "externalServers",
      arguments: () => [],
      resultKey: "servers",
    }),
    serviceTool({
      name: "create_external_mcp_server",
      title: "Create external MCP server",
      description:
        "Create an external MCP connection without secret header values. Configure authentication separately in settings.",
      inputSchema: z.object({ input: externalInput }),
      service,
      method: "createExternalServer",
      arguments: ({ input }) => [input],
      resultKey: "server",
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
    }),
    serviceTool({
      name: "update_external_mcp_server",
      title: "Update external MCP server",
      description:
        "Update an external MCP connection, retaining saved headers when headers is omitted. An explicit list selects retained header IDs; an empty list removes all headers.",
      inputSchema: z.object({
        id: identifier,
        input: externalInput.extend({
          headers: z
            .array(z.object({ id: identifier, name: identifier }))
            .max(100)
            .optional(),
        }),
      }),
      service: externalUpdates,
      method: "updateExternalServer",
      arguments: ({ id, input }) => [id, input],
      resultKey: "server",
      annotations: WRITE_ANNOTATIONS,
    }),
    serviceTool({
      name: "delete_external_mcp_server",
      title: "Delete external MCP server",
      description:
        "Delete an external MCP connection and its stored authentication headers.",
      inputSchema: z.object({ id: identifier }),
      service,
      method: "deleteExternalServer",
      arguments: ({ id }) => [id],
      resultKey: "deleted",
      annotations: DESTRUCTIVE_ANNOTATIONS,
    }),
    serviceTool({
      name: "clear_tool_call_history",
      title: "Clear tool-call history",
      description:
        "Permanently clear completed tool-call audit history while retaining active calls.",
      inputSchema: z.object({}),
      service,
      method: "clearToolCallAudits",
      arguments: () => [],
      resultKey: "cleared",
      annotations: DESTRUCTIVE_ANNOTATIONS,
    }),
  ];
}
