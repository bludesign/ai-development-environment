import * as z from "zod/v4";
import { BUILD_CONFIGURATION_ICON_KEYS } from "@ai-development-environment/agent-contract/builds";

export const MCP_PRESET_EXPORT_FORMAT = "aide.mcp-presets.export";
export const MAX_MCP_IMPORT_BYTES = 2 * 1024 * 1024;
export const PortableMcpToolReferenceSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("BUILTIN"),
      name: z.string().trim().min(1).max(256),
    })
    .strict(),
  z
    .object({
      source: z.literal("EXTERNAL"),
      serverKey: z.string().min(1).max(100),
      name: z.string().min(1).max(256),
    })
    .strict(),
]);
export const PortableMcpPresetSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).default(""),
    iconKey: z.enum(BUILD_CONFIGURATION_ICON_KEYS),
    enabledForPlans: z.boolean(),
    enabledForSessions: z.boolean(),
    tools: z.array(PortableMcpToolReferenceSchema).min(1).max(2000),
  })
  .strict();
export const McpPresetDocumentSchema = z
  .object({
    format: z.literal(MCP_PRESET_EXPORT_FORMAT),
    schemaVersion: z.literal(1),
    externalServers: z
      .array(
        z
          .object({
            key: z.string().min(1).max(100),
            name: z.string().min(1).max(80),
            transport: z.enum(["STREAMABLE_HTTP", "SSE"]).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    presets: z.array(PortableMcpPresetSchema).min(1).max(100),
  })
  .strict();
export type McpPresetDocument = z.infer<typeof McpPresetDocumentSchema>;

export const MCP_PRESET_GENERATION_INSTRUCTIONS =
  "Create a JSON document matching presetSchema. Use only exact tool references from this catalog. Built-in references use source and name; external references use source, serverKey, and the raw upstream name. Choose the smallest useful explicit tool list, considering read-only and destructive annotations. Include a name, description, supported iconKey, and both plan/session booleans. Return JSON only, without Markdown fences. External servers must be mapped to already configured servers during import; never include credentials, headers, local IDs, URLs, invocation arguments, or new server configurations.";

export function parseMcpPresetDocument(document: string): McpPresetDocument {
  if (new TextEncoder().encode(document).length > MAX_MCP_IMPORT_BYTES)
    throw new Error("Preset document must be 2 MiB or smaller");
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    throw new Error("Preset document is not valid JSON");
  }
  const result = McpPresetDocumentSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      result.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "document"}: ${issue.message}`,
        )
        .join("; "),
    );
  const keys = result.data.externalServers.map(({ key }) => key);
  if (new Set(keys).size !== keys.length)
    throw new Error("External server keys must be unique");
  for (const preset of result.data.presets) {
    const references = preset.tools.map((tool) => JSON.stringify(tool));
    if (new Set(references).size !== references.length)
      throw new Error(
        `Preset ${preset.name} contains duplicate tool references`,
      );
    for (const tool of preset.tools)
      if (tool.source === "EXTERNAL" && !keys.includes(tool.serverKey))
        throw new Error(`Unknown external server key: ${tool.serverKey}`);
  }
  return result.data;
}

export function mcpPresetJsonSchema() {
  return z.toJSONSchema(McpPresetDocumentSchema);
}
