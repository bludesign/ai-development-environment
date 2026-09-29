import { createHash } from "node:crypto";
import type { ToolsService, McpExternalDiscoveryCache } from "./tools.service";
import type {
  McpToolDocumentExport,
  McpToolPresetImportInput,
  McpToolPresetImportPreview,
  McpToolPresetInput,
  McpToolReference,
  ToolCatalogGroup,
} from "./types";
import {
  MAX_MCP_IMPORT_BYTES,
  MCP_PRESET_EXPORT_FORMAT,
  MCP_PRESET_GENERATION_INSTRUCTIONS,
  mcpPresetJsonSchema,
  parseMcpPresetDocument,
} from "./mcp-preset-format";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jsonExport = (
  filename: string,
  value: unknown,
): McpToolDocumentExport => ({
  filename,
  contentType: "application/json",
  content: JSON.stringify(value, null, 2),
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const fence = (value: unknown) => {
  const text = JSON.stringify(value, null, 2);
  const ticks = "`".repeat(
    Math.max(3, ...[...text.matchAll(/`+/g)].map(([run]) => run.length + 1)),
  );
  return `${ticks}json\n${text}\n${ticks}`;
};

/** One server-owned format and validation path for the web and native clients. */
export class McpPresetTransferService {
  constructor(private readonly tools: ToolsService) {}

  async exportPresets(ids: string[]): Promise<McpToolDocumentExport> {
    if (!ids.length || ids.length > 100)
      throw new Error("Choose between 1 and 100 presets to export");
    const all = await this.tools.mcpToolPresets();
    const selected = [...new Set(ids)]
      .map((id) => {
        const preset = all.find((value) => value.id === id);
        if (!preset) throw new Error("MCP tool preset not found");
        return preset;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const servers = await this.tools.externalServers();
    const needed = new Set(
      selected.flatMap((preset) =>
        preset.tools
          .filter(({ source }) => source === "EXTERNAL")
          .map(({ serverId }) => serverId!),
      ),
    );
    const external = servers
      .filter(({ id }) => needed.has(id))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (external.length !== needed.size)
      throw new Error("A preset references a missing external server");
    const keys = new Map(
      external.map((server, index) => [server.id, `server-${index + 1}`]),
    );
    const exported = jsonExport("mcp-presets.json", {
      format: MCP_PRESET_EXPORT_FORMAT,
      schemaVersion: 1,
      externalServers: external.map((server) => ({
        key: keys.get(server.id),
        name: server.name,
        transport: server.transport,
      })),
      presets: selected.map(
        ({
          name,
          description,
          iconKey,
          enabledForPlans,
          enabledForSessions,
          tools,
        }) => ({
          name,
          description,
          iconKey,
          enabledForPlans,
          enabledForSessions,
          tools: tools.map((tool) =>
            tool.source === "BUILTIN"
              ? { source: tool.source, name: tool.name }
              : {
                  source: tool.source,
                  serverKey: keys.get(tool.serverId!),
                  name: tool.name,
                },
          ),
        }),
      ),
    });
    if (
      new TextEncoder().encode(exported.content).length > MAX_MCP_IMPORT_BYTES
    )
      throw new Error(
        "Preset export exceeds the 2 MiB import limit. Select fewer presets and export them separately.",
      );
    return exported;
  }

  async exportCatalog(
    format: "JSON" | "MARKDOWN",
    source: "ALL" | "BUILTIN" | "EXTERNAL" = "ALL",
    groupIds?: string[] | null,
  ): Promise<McpToolDocumentExport> {
    const catalog = await this.tools.catalog({
      source: source === "ALL" ? undefined : source,
      includeUnavailable: true,
    });
    const selected = new Set(groupIds ?? []);
    const filter = (group: ToolCatalogGroup): ToolCatalogGroup | null => {
      if (!selected.size || selected.has(group.id)) return group;
      const children = group.children
        .map(filter)
        .filter((value): value is ToolCatalogGroup => value !== null);
      return children.length ? { ...group, tools: [], children } : null;
    };
    const groups = catalog.groups
      .map(filter)
      .filter((value): value is ToolCatalogGroup => value !== null);
    const external = groups
      .filter(({ source }) => source === "EXTERNAL")
      .sort((a, b) => a.name.localeCompare(b.name));
    const keys = new Map(
      external.map((group, index) => [
        group.id.replace(/^external:/, ""),
        `server-${index + 1}`,
      ]),
    );
    const portable = (group: ToolCatalogGroup): unknown => ({
      key:
        group.source === "EXTERNAL"
          ? keys.get(group.id.replace(/^external:/, ""))
          : group.id,
      name: group.name,
      source: group.source,
      error: group.error
        ? "Server unavailable; this catalog is incomplete. Reconnect and export again."
        : null,
      tools: group.tools.map((tool) => {
        const ref = tool.reference ?? {
          source: "BUILTIN" as const,
          name: tool.name,
        };
        return {
          reference:
            ref.source === "BUILTIN"
              ? { source: ref.source, name: ref.name }
              : {
                  source: ref.source,
                  serverKey: keys.get(ref.serverId!),
                  name: ref.name,
                },
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
          available: tool.available ?? true,
          availabilityReason: tool.availabilityReason ?? null,
        };
      }),
      children: group.children.map(portable),
    });
    const flatten = (values: ToolCatalogGroup[]): ToolCatalogGroup["tools"] =>
      values.flatMap((group) => [...group.tools, ...flatten(group.children)]);
    const exampleTool = flatten(groups).find(
      (tool) => tool.available !== false,
    );
    const exampleRef = exampleTool?.reference;
    const exampleServers =
      exampleRef?.source === "EXTERNAL"
        ? external
            .filter((group) => group.id === `external:${exampleRef.serverId}`)
            .map((group) => ({
              key: keys.get(exampleRef.serverId!),
              name: group.name,
              transport: group.transport,
            }))
        : [];
    const document = {
      format: "aide.mcp-tool-catalog",
      schemaVersion: 1,
      instructions: MCP_PRESET_GENERATION_INSTRUCTIONS,
      presetSchema: mcpPresetJsonSchema(),
      example: exampleRef
        ? {
            format: MCP_PRESET_EXPORT_FORMAT,
            schemaVersion: 1,
            externalServers: exampleServers,
            presets: [
              {
                name: "Example preset",
                description: exampleTool?.description?.slice(0, 1000) ?? "",
                iconKey: "wrench",
                enabledForPlans: true,
                enabledForSessions: true,
                tools: [
                  exampleRef.source === "BUILTIN"
                    ? { source: exampleRef.source, name: exampleRef.name }
                    : {
                        source: exampleRef.source,
                        name: exampleRef.name,
                        serverKey: keys.get(exampleRef.serverId!),
                      },
                ],
              },
            ],
          }
        : null,
      externalServers: external.map((group) => ({
        key: keys.get(group.id.replace(/^external:/, "")),
        name: group.name,
        transport: group.transport,
      })),
      groups: groups.map(portable),
    };
    if (format === "JSON") return jsonExport("mcp-tool-catalog.json", document);
    return {
      filename: "mcp-tool-catalog.md",
      contentType: "text/markdown",
      content: `# MCP tool catalog\n\n${MCP_PRESET_GENERATION_INSTRUCTIONS}\n\n## Importable preset schema\n\n${fence(document.presetSchema)}\n\n## Example preset\n\n${fence(document.example)}\n\n## External server keys\n\n${fence(document.externalServers)}\n\n## Available tools\n\n${fence(document.groups)}\n`,
    };
  }

  private async prepare(input: McpToolPresetImportInput) {
    const preview: McpToolPresetImportPreview = {
      token: "",
      canImport: false,
      errors: [],
      entries: [],
      externalServers: [],
    };
    const prepared: Array<{
      targetId: string | null;
      input: McpToolPresetInput;
    }> = [];
    const endpoints: Array<{ serverId: string; endpointHash: string }> = [];
    let document;
    try {
      document = parseMcpPresetDocument(input.document);
    } catch (error) {
      preview.errors.push(message(error));
      preview.token = hash(input);
      return { preview, prepared, stateHash: "", endpoints };
    }
    const [existing, servers, stateHash, builtInCatalog] = await Promise.all([
      this.tools.mcpToolPresets(),
      this.tools.externalServers(),
      this.tools.mcpPresetStateHash(),
      this.tools.catalog({ source: "BUILTIN", includeUnavailable: true }),
    ]);
    const unavailable = new Map<string, string>();
    const visit = (groups: ToolCatalogGroup[]) => {
      for (const group of groups) {
        for (const tool of group.tools)
          if (tool.available === false)
            unavailable.set(
              tool.name,
              tool.availabilityReason ?? "Tool credentials are not configured",
            );
        visit(group.children);
      }
    };
    visit(builtInCatalog.groups);
    const discovery: McpExternalDiscoveryCache = new Map();
    const decisions = new Map(
      (input.decisions ?? []).map((decision) => [decision.index, decision]),
    );
    const mappings = new Map(
      (input.serverMappings ?? []).map((mapping) => [
        mapping.serverKey,
        mapping.serverId,
      ]),
    );
    if (decisions.size !== (input.decisions ?? []).length)
      preview.errors.push(
        "Preset decisions must not contain duplicate indices",
      );
    if (mappings.size !== (input.serverMappings ?? []).length)
      preview.errors.push("Server mappings must not contain duplicate keys");
    for (const index of decisions.keys())
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= document.presets.length
      )
        preview.errors.push(`Unknown preset index: ${index}`);
    for (const key of mappings.keys())
      if (!document.externalServers.some((server) => server.key === key))
        preview.errors.push(`Unknown external server key: ${key}`);
    preview.externalServers = document.externalServers.map((server) => {
      const matches = servers.filter(
        (candidate) =>
          candidate.name === server.name &&
          (!server.transport || candidate.transport === server.transport),
      );
      return {
        ...server,
        transport: server.transport ?? null,
        selectedServerId: mappings.get(server.key) ?? null,
        suggestedServerId: matches.length === 1 ? matches[0]!.id : null,
        candidates: servers,
      };
    });
    // Discover each selected server once, concurrently. The shared promise cache
    // also retains failures so a bundle cannot repeat a slow failing connection.
    const probes = new Map<string, McpToolReference>();
    for (const [index, preset] of document.presets.entries()) {
      if (decisions.get(index)?.action === "SKIP") continue;
      for (const tool of preset.tools) {
        if (tool.source !== "EXTERNAL") continue;
        const serverId = mappings.get(tool.serverKey);
        if (
          serverId &&
          servers.some(({ id }) => id === serverId) &&
          !probes.has(serverId)
        )
          probes.set(serverId, {
            source: "EXTERNAL",
            serverId,
            name: tool.name,
          });
      }
    }
    await Promise.allSettled(
      [...probes.values()].map((reference) =>
        this.tools.resolveMcpToolReferences([reference], discovery),
      ),
    );
    const replaced = new Set<string>();
    const fingerprints: unknown[] = [];
    for (const [index, preset] of document.presets.entries()) {
      const decision = decisions.get(index);
      const action = decision?.action ?? "CREATE";
      const entry: McpToolPresetImportPreview["entries"][number] = {
        index,
        name: decision?.name?.trim() ?? preset.name,
        action,
        targetId: decision?.targetId ?? null,
        toolCount: preset.tools.length,
        errors: [],
        warnings: [],
      };
      preview.entries.push(entry);
      if (action === "SKIP") continue;
      if (!["CREATE", "REPLACE"].includes(action)) {
        entry.errors.push("Unsupported import action");
        continue;
      }
      if (action === "CREATE" && entry.targetId)
        entry.errors.push("A new preset cannot specify a replacement target");
      if (action === "REPLACE") {
        if (
          !entry.targetId ||
          !existing.some(({ id }) => id === entry.targetId)
        )
          entry.errors.push("Choose an existing preset to replace");
        else if (replaced.has(entry.targetId))
          entry.errors.push("A preset can only be replaced once per import");
        else replaced.add(entry.targetId);
      }
      const refs: McpToolReference[] = [];
      for (const tool of preset.tools) {
        if (tool.source === "BUILTIN") {
          refs.push(tool);
          if (unavailable.has(tool.name))
            entry.warnings.push(`${tool.name}: ${unavailable.get(tool.name)}`);
        } else {
          const serverId = mappings.get(tool.serverKey);
          if (!serverId || !servers.some(({ id }) => id === serverId))
            entry.errors.push(
              `Map external server ${tool.serverKey} to an existing configured server`,
            );
          else refs.push({ source: "EXTERNAL", serverId, name: tool.name });
        }
      }
      if (entry.errors.length) continue;
      const value: McpToolPresetInput = {
        ...preset,
        name: entry.name,
        tools: refs,
      };
      try {
        await this.tools.normalizeMcpToolPresetInput(value);
        const snapshot = await this.tools.resolveMcpToolReferences(
          refs,
          discovery,
        );
        fingerprints.push({ index, snapshot });
        endpoints.push(
          ...snapshot.tools
            .filter(({ reference }) => reference.source === "EXTERNAL")
            .map(({ reference, endpointHash }) => ({
              serverId: reference.serverId!,
              endpointHash: endpointHash!,
            })),
        );
        prepared.push({
          targetId: action === "REPLACE" ? entry.targetId : null,
          input: value,
        });
      } catch (error) {
        entry.errors.push(message(error));
      }
    }
    const names = new Set(
      existing
        .filter(({ id }) => !replaced.has(id))
        .map(({ name }) => name.toLocaleLowerCase()),
    );
    for (const entry of preview.entries.filter(
      ({ action }) => action !== "SKIP",
    )) {
      const normalized = entry.name.toLocaleLowerCase();
      if (names.has(normalized))
        entry.errors.push(
          "A preset with this name already exists; rename it or choose Replace/Skip",
        );
      names.add(normalized);
    }
    if (!preview.entries.some(({ action }) => action !== "SKIP"))
      preview.errors.push("Choose at least one preset to import");
    preview.canImport =
      preview.errors.length === 0 &&
      preview.entries.every(({ errors }) => !errors.length);
    preview.token = hash({
      input,
      stateHash,
      servers: servers.map(({ id, name, url, transport, updatedAt }) => ({
        id,
        name,
        url,
        transport,
        updatedAt,
      })),
      fingerprints,
      entries: preview.entries,
    });
    return { preview, prepared, stateHash, endpoints };
  }

  async preview(
    input: McpToolPresetImportInput,
  ): Promise<McpToolPresetImportPreview> {
    return (await this.prepare(input)).preview;
  }

  async import(input: McpToolPresetImportInput, previewToken: string) {
    const result = await this.prepare(input);
    if (result.preview.token !== previewToken)
      throw new Error(
        "The document, choices, or available tools changed. Review the import again.",
      );
    if (!result.preview.canImport)
      throw new Error("Resolve all import errors before importing presets");
    return this.tools.importMcpToolPresetBatch(
      result.prepared,
      result.stateHash,
      result.endpoints,
    );
  }
}
