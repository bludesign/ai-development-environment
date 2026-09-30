import { createHash, randomUUID } from "node:crypto";

import { BUILD_CONFIGURATION_ICON_KEYS } from "@ai-development-environment/agent-contract/builds";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import type { BuildsService } from "@/services/builds";
import type { CodebaseToolsService } from "@/services/codebases";
import {
  CREDENTIALS,
  CredentialService,
  externalMcpHeadersCredential,
} from "@/services/credentials";

import {
  createBuiltInToolRegistry,
  type BuiltInToolRegistry,
  type BuiltInToolServices,
} from "./builtin-tools";
import {
  ToolCallAuditService,
  type ToolInvocationContext,
} from "./tool-call-audit.service";
import {
  externalEndpointHash,
  externalMcpName,
  toolReferenceKey,
} from "./mcp-tool-reference";
import { McpPresetTransferService } from "./mcp-preset-transfer.service";
import { compileMcpJsonSchema } from "./mcp-json-schema";

import type {
  ExternalMcpServerInput,
  ExternalMcpServerView,
  ExternalMcpTransport,
  McpToolPresetInput,
  McpToolPresetView,
  ToolCatalogGroup,
  ToolCatalogItem,
  ToolCallAuditView,
  McpToolReference,
  McpToolSnapshot,
  McpToolSnapshotEntry,
} from "./types";

const EXTERNAL_GROUP_PREFIX = "external:";
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOLS_LIST_PAGES = 100;
const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding",
]);
const MCP_PRESET_ICON_KEYS = new Set<string>(BUILD_CONFIGURATION_ICON_KEYS);
const RUN_REPOSITORY_SCOPED_TOOLS = new Set([
  "get_codebase_repository_preparations",
  "save_codebase_repository_preparations",
]);

export type ServerWithSecrets = {
  id: string;
  name: string;
  url: string;
  transport: string;
  toolNamePrefix: string;
  headers: Array<{ id: string; name: string; value: string }>;
};

export type McpExternalDiscoveryCache = Map<
  string,
  Promise<{ server: ServerWithSecrets; tools: ToolCatalogItem[] }>
>;

type ServerMetadata = Omit<ServerWithSecrets, "headers"> & {
  headers: Array<{ id: string; name: string }>;
};

type StoredExternalMcpHeader = { id: string; name: string; value: string };

function transport(value: string): ExternalMcpTransport {
  if (value === "STREAMABLE_HTTP" || value === "SSE") return value;
  throw new Error(`Unsupported MCP transport: ${value}`);
}

function view(
  server: ServerMetadata & { createdAt: Date; updatedAt: Date },
  headersConfigured: boolean,
): ExternalMcpServerView {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    transport: transport(server.transport),
    toolNamePrefix: server.toolNamePrefix,
    headers: [...server.headers]
      .sort((first, second) => first.name.localeCompare(second.name))
      .map((header) => ({
        id: header.id,
        name: header.name,
        valueConfigured: headersConfigured,
      })),
    createdAt: server.createdAt.toISOString(),
    updatedAt: server.updatedAt.toISOString(),
  };
}

export function normalizeExternalMcpServerInput(input: ExternalMcpServerInput) {
  const name = input.name.trim();
  if (!name) throw new Error("Server name is required");
  if (name.length > 80)
    throw new Error("Server name must be 80 characters or fewer");

  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new Error("Server URL must be a valid HTTP or HTTPS URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Server URL must be an HTTP or HTTPS URL without embedded credentials",
    );
  }
  if (input.transport !== "STREAMABLE_HTTP" && input.transport !== "SSE") {
    throw new Error("Transport must be Streamable HTTP or SSE");
  }

  const toolNamePrefix = input.toolNamePrefix?.trim() ?? "";
  if (toolNamePrefix.length > 64 || !/^[A-Za-z0-9_.-]*$/.test(toolNamePrefix)) {
    throw new Error(
      "Tool name prefix may contain up to 64 letters, numbers, underscores, periods, or hyphens",
    );
  }

  const names = new Set<string>();
  const headers = input.headers.map((header) => {
    const headerName = header.name.trim();
    if (!headerName) throw new Error("Header name is required");
    const lowerName = headerName.toLowerCase();
    if (RESERVED_HEADERS.has(lowerName)) {
      throw new Error(`${headerName} is managed by the MCP transport`);
    }
    if (names.has(lowerName))
      throw new Error(`Duplicate header name: ${headerName}`);
    names.add(lowerName);
    try {
      new Headers([[headerName, header.value ?? "validation"]]);
    } catch {
      throw new Error(`Invalid HTTP header: ${headerName}`);
    }
    return {
      id: header.id ?? null,
      name: headerName,
      value: header.value,
    };
  });

  return {
    name,
    url: url.toString(),
    transport: input.transport,
    toolNamePrefix,
    headers,
  };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function presetView(preset: {
  id: string;
  name: string;
  description: string;
  iconKey: string;
  enabledForPlans: boolean;
  enabledForSessions: boolean;
  createdAt: Date;
  updatedAt: Date;
  tools: Array<{ toolName: string }>;
  externalTools?: Array<{
    serverId: string;
    toolName: string;
    server?: { name: string };
  }>;
}): McpToolPresetView {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    iconKey: preset.iconKey,
    enabledForPlans: preset.enabledForPlans,
    enabledForSessions: preset.enabledForSessions,
    toolNames: preset.tools.map(({ toolName }) => toolName).sort(),
    tools: [
      ...preset.tools.map(({ toolName }): McpToolReference => ({
        source: "BUILTIN",
        name: toolName,
      })),
      ...(preset.externalTools ?? []).map(
        ({ serverId, toolName, server }): McpToolReference => ({
          source: "EXTERNAL",
          serverId,
          name: toolName,
          serverName: server?.name ?? null,
        }),
      ),
    ].sort((a, b) => toolReferenceKey(a).localeCompare(toolReferenceKey(b))),
    createdAt: preset.createdAt.toISOString(),
    updatedAt: preset.updatedAt.toISOString(),
  };
}

export class ToolsService {
  readonly presetTransfers = new McpPresetTransferService(this);
  private readonly remoteCatalogs = new Map<
    string,
    {
      signature: string;
      expiresAt: number;
      promise: Promise<ToolCatalogItem[]>;
    }
  >();

  private remoteCatalog(server: ServerWithSecrets, reuse: boolean) {
    const signature = createHash("sha256")
      .update(JSON.stringify(server))
      .digest("hex");
    const previous = this.remoteCatalogs.get(server.id);
    if (
      previous?.signature === signature &&
      previous.expiresAt > Date.now() &&
      reuse
    )
      return previous.promise;
    // Share concurrent fresh loads, but a later explicit refresh always discovers
    // tool changes. Schema expansion can reuse the just-fetched catalog snapshot.
    if (previous?.signature === signature && previous.expiresAt === Infinity)
      return previous.promise;
    const entry = {
      signature,
      expiresAt: Infinity,
      promise: this.listRemoteTools(server),
    };
    this.remoteCatalogs.delete(server.id);
    this.remoteCatalogs.set(server.id, entry);
    if (this.remoteCatalogs.size > 32)
      this.remoteCatalogs.delete(this.remoteCatalogs.keys().next().value!);
    void entry.promise.then(
      () => {
        entry.expiresAt = Date.now() + 60_000;
      },
      () => {
        if (this.remoteCatalogs.get(server.id) === entry)
          this.remoteCatalogs.delete(server.id);
      },
    );
    return entry.promise;
  }

  readonly builtInTools: BuiltInToolRegistry;

  constructor(
    codebaseTools: CodebaseToolsService,
    builds?: BuildsService,
    additional: Omit<BuiltInToolServices, "codebaseTools" | "builds"> = {},
    private readonly credentials = new CredentialService(),
    private readonly audit = new ToolCallAuditService(),
  ) {
    this.builtInTools = createBuiltInToolRegistry({
      codebaseTools,
      builds,
      ...additional,
      toolAudit: this.audit,
      testExternalMcpServer: (id) => this.testExternalServer(id),
      listMcpToolPresets: (kind) => this.mcpToolPresets(kind),
    });
  }

  async mcpToolPresets(kind?: string | null): Promise<McpToolPresetView[]> {
    const normalizedKind = kind?.trim().toUpperCase() ?? null;
    if (normalizedKind && !["PLAN", "SESSION"].includes(normalizedKind)) {
      throw new Error("Run kind is not supported");
    }
    const prisma = await getPrismaClient();
    const presets = await prisma.mcpToolPreset.findMany({
      where:
        normalizedKind === "PLAN"
          ? { enabledForPlans: true }
          : normalizedKind === "SESSION"
            ? { enabledForSessions: true }
            : undefined,
      orderBy: { name: "asc" },
      include: { tools: true, externalTools: { include: { server: true } } },
    });
    return presets.map(presetView);
  }

  async toolCallAudits(
    input: {
      first?: number;
      toolName?: string | null;
      resultStatus?: string | null;
    } = {},
  ): Promise<ToolCallAuditView[]> {
    return this.audit.list(input);
  }

  async clearToolCallAudits(): Promise<{ count: number }> {
    return this.audit.clear();
  }

  async createMcpToolPreset(
    input: McpToolPresetInput,
  ): Promise<McpToolPresetView> {
    return this.saveMcpToolPreset(null, input);
  }

  async updateMcpToolPreset(
    id: string,
    input: McpToolPresetInput,
  ): Promise<McpToolPresetView> {
    return this.saveMcpToolPreset(id, input);
  }

  /** Shared by ordinary edits and portable import previews. */
  async normalizeMcpToolPresetInput(input: McpToolPresetInput) {
    const name = input.name.trim();
    const description = input.description?.trim() ?? "";
    if (!name) throw new Error("Preset name is required");
    if (name.length > 80)
      throw new Error("Preset name must be 80 characters or fewer");
    if (description.length > 1_000)
      throw new Error("Preset description must be 1,000 characters or fewer");
    if (!MCP_PRESET_ICON_KEYS.has(input.iconKey))
      throw new Error("Preset icon is not supported");
    if (
      typeof input.enabledForPlans !== "boolean" ||
      typeof input.enabledForSessions !== "boolean"
    )
      throw new Error("Preset eligibility must use boolean values");
    if (input.tools != null && input.toolNames != null)
      throw new Error("Provide tools or legacy toolNames, not both");
    const tools: McpToolReference[] =
      input.tools != null
        ? input.tools.map((tool) => ({
            source: tool.source,
            name: tool.source === "BUILTIN" ? tool.name.trim() : tool.name,
            ...(tool.source === "EXTERNAL" ? { serverId: tool.serverId } : {}),
          }))
        : (input.toolNames ?? []).map((name) => ({
            source: "BUILTIN",
            name: name.trim(),
          }));
    if (!tools.length) throw new Error("Select at least one tool");
    if (tools.length > 2000) throw new Error("Select no more than 2,000 tools");
    if (new Set(tools.map(toolReferenceKey)).size !== tools.length)
      throw new Error("Preset tool membership must not contain duplicates");
    const knownNames = new Set(
      this.builtInTools.definitions().map(({ name }) => name),
    );
    for (const tool of tools) {
      if (!tool.name || tool.name.length > 256)
        throw new Error(
          "Tool name is required and must be 256 characters or fewer",
        );
      if (tool.source === "BUILTIN") {
        if (!knownNames.has(tool.name))
          throw new Error(`Unknown built-in tool: ${tool.name}`);
      } else if (tool.source === "EXTERNAL") {
        if (!tool.serverId)
          throw new Error(
            `External tool ${tool.name} needs a configured server`,
          );
      } else throw new Error("Unsupported tool source");
    }
    return {
      name,
      description,
      iconKey: input.iconKey,
      enabledForPlans: input.enabledForPlans,
      enabledForSessions: input.enabledForSessions,
      tools,
    };
  }

  private async writePreset(
    transaction: Prisma.TransactionClient,
    id: string,
    input: Awaited<ReturnType<ToolsService["normalizeMcpToolPresetInput"]>>,
  ) {
    const { tools, ...metadata } = input;
    await transaction.mcpToolPreset.upsert({
      where: { id },
      create: { id, ...metadata },
      update: metadata,
    });
    await transaction.mcpToolPresetTool.deleteMany({ where: { presetId: id } });
    const builtIn = tools.filter(({ source }) => source === "BUILTIN");
    if (builtIn.length)
      await transaction.mcpToolPresetTool.createMany({
        data: builtIn.map(({ name }) => ({ presetId: id, toolName: name })),
      });
    await transaction.mcpToolPresetExternalTool.deleteMany({
      where: { presetId: id },
    });
    const external = tools.filter(({ source }) => source === "EXTERNAL");
    if (external.length)
      await transaction.mcpToolPresetExternalTool.createMany({
        data: external.map(({ name, serverId }) => ({
          presetId: id,
          serverId: serverId!,
          toolName: name,
        })),
      });
  }

  private async assertExternalEndpoints(
    transaction: Prisma.TransactionClient,
    endpoints: Array<{ serverId: string; endpointHash: string }>,
  ) {
    if (!endpoints.length) return;
    const servers = await transaction.externalMcpServer.findMany({
      where: {
        id: { in: [...new Set(endpoints.map(({ serverId }) => serverId))] },
      },
      select: { id: true, url: true, transport: true },
    });
    const hashes = new Map(
      servers.map((server) => [server.id, externalEndpointHash(server)]),
    );
    if (
      endpoints.some(
        ({ serverId, endpointHash }) => hashes.get(serverId) !== endpointHash,
      )
    )
      throw new Error(
        "An external server changed since validation. Review the preset again.",
      );
  }

  private async saveMcpToolPreset(
    id: string | null,
    input: McpToolPresetInput,
  ): Promise<McpToolPresetView> {
    const normalized = await this.normalizeMcpToolPresetInput(input);
    const prisma = await getPrismaClient();
    if (id) {
      const existing = await prisma.mcpToolPreset.findUnique({
        where: { id },
        include: { externalTools: true },
      });
      if (!existing) throw new Error("MCP tool preset not found");
      if (input.tools == null && existing.externalTools?.length)
        throw new Error(
          "This preset contains external tools. Upgrade this client before editing it.",
        );
    }
    // Validate external references against a fresh catalog before saving.
    const snapshot = await this.resolveMcpToolReferences(normalized.tools);
    const presetId = id ?? randomUUID();
    await prisma.$transaction(async (transaction) => {
      if (
        id &&
        !(await transaction.mcpToolPreset.findUnique({
          where: { id },
          select: { id: true },
        }))
      )
        throw new Error("MCP tool preset not found");
      if (
        id &&
        input.tools == null &&
        (await transaction.mcpToolPresetExternalTool.count({
          where: { presetId: id },
        }))
      )
        throw new Error(
          "This preset contains external tools. Upgrade this client before editing it.",
        );
      await this.assertExternalEndpoints(
        transaction,
        snapshot.tools
          .filter((tool) => tool.reference.source === "EXTERNAL")
          .map((tool) => ({
            serverId: tool.reference.serverId!,
            endpointHash: tool.endpointHash!,
          })),
      );
      const names = await transaction.mcpToolPreset.findMany({
        select: { id: true, name: true },
      });
      if (
        names.some(
          (preset) =>
            preset.id !== id &&
            preset.name.toLocaleLowerCase() ===
              normalized.name.toLocaleLowerCase(),
        )
      )
        throw new Error("An MCP tool preset with this name already exists");
      await this.writePreset(transaction, presetId, normalized);
    });
    const saved = await prisma.mcpToolPreset.findUniqueOrThrow({
      where: { id: presetId },
      include: { tools: true, externalTools: { include: { server: true } } },
    });
    return presetView(saved);
  }

  /** The complete preview is rechecked inside the write transaction. */
  async importMcpToolPresetBatch(
    entries: Array<{ targetId: string | null; input: McpToolPresetInput }>,
    expectedState: string,
    endpoints: Array<{ serverId: string; endpointHash: string }>,
  ): Promise<McpToolPresetView[]> {
    const normalized = await Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        input: await this.normalizeMcpToolPresetInput(entry.input),
      })),
    );
    const prisma = await getPrismaClient();
    const ids = await prisma.$transaction(async (transaction) => {
      await this.assertExternalEndpoints(transaction, endpoints);
      const existing = await transaction.mcpToolPreset.findMany({
        orderBy: { id: "asc" },
        include: { tools: true, externalTools: true },
      });
      if (this.presetStateHash(existing) !== expectedState)
        throw new Error(
          "Presets changed since preview. Review the import again.",
        );
      const plannedNames = new Map(
        existing.map(({ id, name }) => [id, name.toLocaleLowerCase()]),
      );
      const result: string[] = [];
      for (const entry of normalized) {
        const id = entry.targetId ?? randomUUID();
        if (entry.targetId && !plannedNames.has(id))
          throw new Error("Replacement preset no longer exists");
        plannedNames.set(id, entry.input.name.toLocaleLowerCase());
        result.push(id);
      }
      if (new Set(plannedNames.values()).size !== plannedNames.size)
        throw new Error("An MCP tool preset with this name already exists");
      for (const [index, entry] of normalized.entries())
        await this.writePreset(transaction, result[index]!, entry.input);
      return result;
    });
    const saved = await prisma.mcpToolPreset.findMany({
      where: { id: { in: ids } },
      include: { tools: true, externalTools: { include: { server: true } } },
    });
    return ids.map((id) =>
      presetView(saved.find((preset) => preset.id === id)!),
    );
  }

  presetStateHash(
    presets: Array<{
      id: string;
      name: string;
      updatedAt: Date;
      tools: Array<{ toolName: string }>;
      externalTools?: Array<{ serverId: string; toolName: string }>;
    }>,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify(
          presets
            .map((preset) => ({
              id: preset.id,
              name: preset.name,
              updatedAt: preset.updatedAt.toISOString(),
              tools: preset.tools.map(({ toolName }) => toolName).sort(),
              external: (preset.externalTools ?? [])
                .map(({ serverId, toolName }) => [serverId, toolName])
                .sort(),
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ),
      )
      .digest("hex");
  }

  async mcpPresetStateHash(): Promise<string> {
    const prisma = await getPrismaClient();
    return this.presetStateHash(
      await prisma.mcpToolPreset.findMany({
        orderBy: { id: "asc" },
        include: { tools: true, externalTools: true },
      }),
    );
  }

  async deleteMcpToolPreset(id: string): Promise<{ id: string }> {
    const prisma = await getPrismaClient();
    await prisma.mcpToolPreset.delete({ where: { id } });
    return { id };
  }

  async resolveRunMcpPresets(
    kind: "PLAN" | "SESSION",
    ids: string[],
  ): Promise<{
    presetIds: string[];
    toolNames: string[];
    snapshot?: McpToolSnapshot;
  }> {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return { presetIds: [], toolNames: [] };
    const prisma = await getPrismaClient();
    const presets = await prisma.mcpToolPreset.findMany({
      where: {
        id: { in: uniqueIds },
        ...(kind === "PLAN"
          ? { enabledForPlans: true }
          : { enabledForSessions: true }),
      },
      include: { tools: true, externalTools: { include: { server: true } } },
    });
    const byId = new Map(presets.map((preset) => [preset.id, preset]));
    const presetIds = uniqueIds.filter((id) => byId.has(id));
    const known = new Set(
      this.builtInTools.definitions().map(({ name }) => name),
    );
    const refs = new Map<string, McpToolReference>();
    for (const id of presetIds) {
      const preset = byId.get(id)!;
      for (const { toolName } of preset.tools)
        if (known.has(toolName)) {
          const ref: McpToolReference = { source: "BUILTIN", name: toolName };
          refs.set(toolReferenceKey(ref), ref);
        }
      for (const { serverId, toolName } of preset.externalTools ?? []) {
        const ref: McpToolReference = {
          source: "EXTERNAL",
          serverId,
          name: toolName,
        };
        refs.set(toolReferenceKey(ref), ref);
      }
    }
    const snapshot = await this.resolveMcpToolReferences([...refs.values()]);
    return {
      presetIds,
      toolNames: snapshot.tools.map(({ name }) => name).sort(),
      snapshot,
    };
  }

  async mcpPresetSnapshot(id: string): Promise<McpToolSnapshot | null> {
    const preset = (await this.mcpToolPresets()).find(
      (value) => value.id === id,
    );
    if (!preset) return null;
    const known = new Set(
      this.builtInTools.definitions().map(({ name }) => name),
    );
    return this.resolveMcpToolReferences(
      preset.tools.filter(
        (tool) => tool.source === "EXTERNAL" || known.has(tool.name),
      ),
    );
  }

  /** Kept for callers using the original built-in-only projection. */
  async mcpPresetToolNames(id: string): Promise<string[] | null> {
    const prisma = await getPrismaClient();
    const preset = await prisma.mcpToolPreset.findUnique({
      where: { id },
      include: { tools: true },
    });
    if (!preset) return null;
    const known = new Set(
      this.builtInTools.definitions().map(({ name }) => name),
    );
    return preset.tools
      .map(({ toolName }) => toolName)
      .filter((name) => known.has(name));
  }

  async mcpRunToolNames(
    runId: string,
    agentId: string,
  ): Promise<
    | {
        status: "OK";
        toolNames: string[];
        repositoryId: string | null;
        snapshot?: McpToolSnapshot;
      }
    | { status: "NOT_FOUND" }
    | { status: "FORBIDDEN" }
  > {
    const prisma = await getPrismaClient();
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: {
        agentId: true,
        mcpToolNamesJson: true,
        mcpToolSnapshotJson: true,
        repositoryId: true,
      },
    });
    if (!run) return { status: "NOT_FOUND" };
    if (run.agentId !== agentId) return { status: "FORBIDDEN" };
    if (run.mcpToolSnapshotJson) {
      const snapshot = JSON.parse(run.mcpToolSnapshotJson) as McpToolSnapshot;
      if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.tools))
        throw new Error("Unsupported MCP run snapshot");
      return {
        status: "OK",
        repositoryId: run.repositoryId,
        toolNames: snapshot.tools.map(({ name }) => name),
        snapshot,
      };
    }
    const parsed: unknown = JSON.parse(run.mcpToolNamesJson);
    const selected = new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [],
    );
    return {
      status: "OK",
      repositoryId: run.repositoryId,
      toolNames: this.builtInTools
        .definitions()
        .map(({ name }) => name)
        .filter((name) => selected.has(name)),
    };
  }

  async resolveMcpToolReferences(
    references: McpToolReference[],
    discovery: McpExternalDiscoveryCache = new Map(),
  ): Promise<McpToolSnapshot> {
    const builtin = new Map<string, ToolCatalogItem>();
    const visit = (groups: ToolCatalogGroup[]) => {
      for (const group of groups) {
        for (const tool of group.tools) builtin.set(tool.name, tool);
        visit(group.children);
      }
    };
    visit(this.builtInTools.catalog());
    const serverIds = [
      ...new Set(
        references
          .filter(({ source }) => source === "EXTERNAL")
          .map(({ serverId }) => serverId!),
      ),
    ];
    const external = new Map<
      string,
      { server: ServerWithSecrets; tools: ToolCatalogItem[] }
    >();
    await Promise.all(
      serverIds.map(async (id) => {
        let promise = discovery.get(id);
        if (!promise) {
          promise = (async () => {
            const server = await this.externalServerWithSecrets(id);
            try {
              return { server, tools: await this.remoteCatalog(server, false) };
            } catch {
              throw new Error(
                `External MCP server ${server.name} is unavailable. Reconnect it or remove its tools before continuing.`,
              );
            }
          })();
          discovery.set(id, promise);
        }
        external.set(id, await promise);
      }),
    );
    const aliases = new Set<string>();
    const tools: McpToolSnapshotEntry[] = references.map((reference) => {
      let entry: McpToolSnapshotEntry;
      if (reference.source === "BUILTIN") {
        const tool = builtin.get(reference.name);
        if (!tool) throw new Error(`Unknown built-in tool: ${reference.name}`);
        entry = { ...tool, reference };
      } else {
        const value = external.get(reference.serverId!);
        const tool = value?.tools.find(({ name }) => name === reference.name);
        if (!value || !tool)
          throw new Error(
            `External tool ${reference.name} is unavailable on ${value?.server.name ?? "the selected server"}`,
          );
        if (tool.taskSupport === "required")
          throw new Error(
            `External tool ${reference.name} requires unsupported task execution`,
          );
        try {
          compileMcpJsonSchema(tool.inputSchema);
          if (tool.outputSchema) compileMcpJsonSchema(tool.outputSchema);
        } catch {
          throw new Error(
            `External tool ${reference.name} has an unsupported JSON Schema`,
          );
        }
        entry = {
          ...tool,
          name: externalMcpName(reference.serverId!, reference.name),
          reference: { ...reference, serverName: value.server.name },
          endpointHash: externalEndpointHash(value.server),
        };
      }
      if (aliases.has(entry.name))
        throw new Error(`MCP tool name collision: ${entry.name}`);
      aliases.add(entry.name);
      return entry;
    });
    return {
      schemaVersion: 1,
      tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async callSnapshotTool(
    entry: McpToolSnapshotEntry,
    args: Record<string, unknown>,
    context: ToolInvocationContext,
    repositoryId?: string | null,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const ref = entry.reference;
    if (ref.source === "BUILTIN")
      return repositoryId === undefined
        ? this.callBuiltInTool(ref.name, args, context)
        : this.callRunBuiltInTool(ref.name, args, repositoryId, context);
    return this.audit.execute(
      {
        ...context,
        groupId: `${EXTERNAL_GROUP_PREFIX}${ref.serverId}`,
        toolName: ref.name,
        arguments: args,
      },
      async () => {
        const server = await this.externalServerWithSecrets(ref.serverId!);
        if (entry.endpointHash !== externalEndpointHash(server))
          throw new Error(
            "External MCP endpoint changed since this run started. Start a new run to use the updated endpoint.",
          );
        const validInput = compileMcpJsonSchema(entry.inputSchema)(args);
        if (!validInput.valid)
          throw new Error(`Invalid tool arguments: ${validInput.errorMessage}`);
        const result = await this.withClient(
          server,
          (client) =>
            client.callTool({ name: ref.name, arguments: args }, undefined, {
              timeout: CALL_TIMEOUT_MS,
              resetTimeoutOnProgress: true,
              signal,
            }),
          signal,
        );
        if (!result.isError && entry.outputSchema) {
          const output = compileMcpJsonSchema(entry.outputSchema)(
            result.structuredContent,
          );
          if (!output.valid)
            throw new Error(
              `Invalid external tool output: ${output.errorMessage}`,
            );
        }
        return result as CallToolResult;
      },
    );
  }

  async externalServers(): Promise<ExternalMcpServerView[]> {
    const prisma = await getPrismaClient();
    const servers = await prisma.externalMcpServer.findMany({
      orderBy: { name: "asc" },
      include: { headers: true },
    });
    return Promise.all(
      servers.map(async (server) =>
        view(
          server,
          server.headers.length === 0 ||
            (await this.credentials.isConfigured(
              externalMcpHeadersCredential(server.id),
            )),
        ),
      ),
    );
  }

  async createExternalServer(
    input: ExternalMcpServerInput,
  ): Promise<ExternalMcpServerView> {
    return this.saveExternalServer(null, input);
  }

  async updateExternalServer(
    id: string,
    input: ExternalMcpServerInput,
  ): Promise<ExternalMcpServerView> {
    return this.saveExternalServer(id, input);
  }

  private async saveExternalServer(
    id: string | null,
    input: ExternalMcpServerInput,
  ): Promise<ExternalMcpServerView> {
    const normalized = normalizeExternalMcpServerInput(input);
    const prisma = await getPrismaClient();
    const allServers = await prisma.externalMcpServer.findMany({
      select: { id: true, name: true },
    });
    if (
      allServers.some(
        (server) =>
          server.id !== id &&
          server.name.toLocaleLowerCase() ===
            normalized.name.toLocaleLowerCase(),
      )
    ) {
      throw new Error("An MCP server with this name already exists");
    }

    const existing = id
      ? await prisma.externalMcpServer.findUnique({
          where: { id },
          include: { headers: true },
        })
      : null;
    if (id && !existing) throw new Error("External MCP server not found");
    const existingHeaders = new Map(
      existing?.headers.map((header) => [header.id, header]) ?? [],
    );
    const serverId = id ?? randomUUID();
    const descriptor = externalMcpHeadersCredential(serverId);
    const storedHeaders = id
      ? ((await this.credentials.getJson<StoredExternalMcpHeader[]>(
          descriptor,
        )) ?? [])
      : [];
    const storedById = new Map(
      storedHeaders.map((header) => [header.id, header]),
    );
    for (const header of normalized.headers) {
      if (header.id && !existingHeaders.has(header.id)) {
        throw new Error(`Header ${header.name} does not belong to this server`);
      }
      if (!header.id && !header.value) {
        throw new Error(
          `A value is required for the new ${header.name} header`,
        );
      }
    }

    const headers: StoredExternalMcpHeader[] = normalized.headers.map(
      (header) => {
        const headerId = header.id ?? randomUUID();
        const value = header.value || storedById.get(headerId)?.value;
        if (!value) throw new Error(`A value is required for ${header.name}`);
        return { id: headerId, name: header.name, value };
      },
    );
    const saveMetadata = async (transaction: Prisma.TransactionClient) => {
      await transaction.externalMcpServer.upsert({
        where: { id: serverId },
        create: {
          id: serverId,
          name: normalized.name,
          url: normalized.url,
          transport: normalized.transport,
          toolNamePrefix: normalized.toolNamePrefix,
        },
        update: {
          name: normalized.name,
          url: normalized.url,
          transport: normalized.transport,
          toolNamePrefix: normalized.toolNamePrefix,
        },
      });
      await transaction.externalMcpServerHeader.deleteMany({
        where: { serverId },
      });
      if (headers.length) {
        await transaction.externalMcpServerHeader.createMany({
          data: headers.map((header) => ({
            id: header.id,
            serverId,
            name: header.name,
          })),
        });
      }
    };
    // Renaming a server or changing its URL must not re-store an unchanged header bundle:
    // that is wasted work on every backend and a hard failure against a read-only Vault.
    const headersChanged =
      JSON.stringify(headers) !== JSON.stringify(storedHeaders);
    if (headers.length && headersChanged) {
      await this.credentials.setJson(descriptor, headers, saveMetadata);
    } else if (!headers.length && storedHeaders.length) {
      await this.credentials.delete(descriptor, saveMetadata);
    } else {
      await prisma.$transaction(saveMetadata);
    }
    const saved = await prisma.externalMcpServer.findUniqueOrThrow({
      where: { id: serverId },
      include: { headers: true },
    });
    return view(saved, true);
  }

  async deleteExternalServer(id: string): Promise<{ id: string }> {
    const prisma = await getPrismaClient();
    if (
      await prisma.mcpToolPresetExternalTool.count({ where: { serverId: id } })
    )
      throw new Error(
        "Remove this server's tools from MCP presets before deleting the server",
      );
    await this.credentials.delete(
      externalMcpHeadersCredential(id),
      async (transaction) => {
        await transaction.externalMcpServer.delete({ where: { id } });
      },
    );
    return { id };
  }

  async testExternalServer(id: string): Promise<{
    id: string;
    name: string;
    toolCount: number;
  }> {
    const server = await this.externalServerWithSecrets(id);
    const tools = await this.listRemoteTools(server);
    return { id: server.id, name: server.name, toolCount: tools.length };
  }

  async catalog(
    options: {
      source?: "BUILTIN" | "EXTERNAL";
      groupId?: string;
      reuse?: boolean;
      includeUnavailable?: boolean;
    } = {},
  ): Promise<{ groups: ToolCatalogGroup[] }> {
    const [builtInGroups, externalGroups] = await Promise.all([
      options.source === "EXTERNAL"
        ? []
        : this.builtInCatalog(options.includeUnavailable),
      options.source === "BUILTIN" ? [] : this.externalCatalog(options),
    ]);
    return { groups: [...builtInGroups, ...externalGroups] };
  }

  private async externalCatalog(options: {
    groupId?: string;
    reuse?: boolean;
  }) {
    const prisma = await getPrismaClient();
    const servers = await prisma.externalMcpServer.findMany({
      ...(options.groupId
        ? { where: { id: options.groupId.replace(EXTERNAL_GROUP_PREFIX, "") } }
        : {}),
      orderBy: { name: "asc" },
      include: { headers: true },
    });
    const externalGroups = await Promise.all(
      servers.map(async (server): Promise<ToolCatalogGroup> => {
        try {
          const tools = await this.remoteCatalog(
            await this.externalServerWithSecrets(server.id),
            options.reuse ?? false,
          );
          return {
            id: `${EXTERNAL_GROUP_PREFIX}${server.id}`,
            name: server.name,
            source: "EXTERNAL",
            transport: transport(server.transport),
            url: server.url,
            error: null,
            tools: tools.map((tool) => ({
              ...tool,
              name: `${server.toolNamePrefix}${tool.name}`,
              reference: {
                source: "EXTERNAL",
                serverId: server.id,
                serverName: server.name,
                name: tool.name,
              },
              mcpName: externalMcpName(server.id, tool.name),
            })),
            children: [],
          };
        } catch (error) {
          return {
            id: `${EXTERNAL_GROUP_PREFIX}${server.id}`,
            name: server.name,
            source: "EXTERNAL",
            transport: transport(server.transport),
            url: server.url,
            error: errorMessage(error),
            tools: [],
            children: [],
          };
        }
      }),
    );
    return externalGroups;
  }

  private async builtInCatalog(includeUnavailable = false) {
    const [githubConfigured, gitlabConfigured] = await Promise.all([
      this.credentials.isConfigured(CREDENTIALS.githubPersonalAccessToken),
      this.credentials.isConfigured(CREDENTIALS.gitlabAccessToken),
    ]);
    const builtInGroups = this.builtInTools
      .catalog()
      .filter((group) => {
        if (includeUnavailable) return true;
        if (group.id === "builtin:github") return githubConfigured;
        if (group.id === "builtin:gitlab") return gitlabConfigured;
        return true;
      })
      .map((group) =>
        group.id === "builtin:cache-administration"
          ? {
              ...group,
              children: group.children.filter((child) => {
                if (includeUnavailable) return true;
                if (child.id === "builtin:cache-administration:github") {
                  return githubConfigured;
                }
                if (child.id === "builtin:cache-administration:gitlab") {
                  return gitlabConfigured;
                }
                return true;
              }),
            }
          : group,
      );
    const references = (group: ToolCatalogGroup): ToolCatalogGroup => {
      const available =
        group.id === "builtin:github" ||
        group.id === "builtin:cache-administration:github"
          ? githubConfigured
          : group.id === "builtin:gitlab" ||
              group.id === "builtin:cache-administration:gitlab"
            ? gitlabConfigured
            : true;
      return {
        ...group,
        tools: group.tools.map((tool) => ({
          ...tool,
          reference: { source: "BUILTIN", name: tool.name },
          mcpName: tool.name,
          available,
          availabilityReason: available
            ? null
            : "Configure the provider's primary access token before using this tool",
        })),
        children: group.children.map(references),
      };
    };
    return builtInGroups.map(references);
  }

  async callTool(
    input: {
      groupId: string;
      name: string;
      arguments: Record<string, unknown>;
    },
    context?: ToolInvocationContext,
  ): Promise<unknown> {
    const operation = () => this.invokeTool(input);
    return context
      ? this.audit.execute(
          {
            ...context,
            groupId: input.groupId,
            toolName: input.name,
            arguments: input.arguments,
          },
          operation,
        )
      : operation();
  }

  async callBuiltInTool(
    name: string,
    args: unknown,
    context?: ToolInvocationContext,
  ): ReturnType<BuiltInToolRegistry["callByName"]> {
    const groupId = this.builtInTools.groupIdForName(name);
    if (!groupId) throw new Error(`Unknown built-in tool: ${name}`);
    await this.assertProviderToolConfigured(groupId);
    const operation = () => this.builtInTools.callByName(name, args);
    return context
      ? this.audit.execute(
          { ...context, groupId, toolName: name, arguments: args },
          operation,
        )
      : operation();
  }

  async callRunBuiltInTool(
    name: string,
    args: unknown,
    repositoryId: string | null,
    context?: ToolInvocationContext,
  ): ReturnType<BuiltInToolRegistry["callByName"]> {
    if (RUN_REPOSITORY_SCOPED_TOOLS.has(name)) {
      const input =
        typeof args === "object" && args !== null && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : null;
      if (!repositoryId || input?.repositoryId !== repositoryId) {
        throw new Error(
          "Run-scoped MCP may only access preparations for the run repository",
        );
      }
    }
    return this.callBuiltInTool(name, args, context);
  }

  private async invokeTool(input: {
    groupId: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown> {
    if (this.builtInTools.hasGroup(input.groupId)) {
      await this.assertProviderToolConfigured(input.groupId);
      return this.builtInTools.call(input.groupId, input.name, input.arguments);
    }
    if (!input.groupId.startsWith(EXTERNAL_GROUP_PREFIX)) {
      throw new Error("Unknown tool group");
    }
    const id = input.groupId.slice(EXTERNAL_GROUP_PREFIX.length);
    const server = await this.externalServerWithSecrets(id);
    if (!input.name.startsWith(server.toolNamePrefix)) {
      throw new Error("Tool name does not use this server's configured prefix");
    }
    const remoteName = input.name.slice(server.toolNamePrefix.length);
    if (!remoteName) throw new Error("Tool name is required");
    return this.withClient(server, (client) =>
      client.callTool(
        { name: remoteName, arguments: input.arguments },
        undefined,
        { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
      ),
    );
  }

  private async assertProviderToolConfigured(groupId: string): Promise<void> {
    const descriptor =
      groupId === "builtin:github" ||
      groupId === "builtin:cache-administration:github"
        ? CREDENTIALS.githubPersonalAccessToken
        : groupId === "builtin:gitlab" ||
            groupId === "builtin:cache-administration:gitlab"
          ? CREDENTIALS.gitlabAccessToken
          : null;
    if (!descriptor) return;
    if (!(await this.credentials.isConfigured(descriptor))) {
      throw new Error(
        `${groupId.includes("github") ? "GitHub" : "GitLab"} tools are unavailable until the provider's primary access token is configured`,
      );
    }
  }

  private async externalServerWithSecrets(
    id: string,
  ): Promise<ServerWithSecrets> {
    const prisma = await getPrismaClient();
    const server = await prisma.externalMcpServer.findUnique({
      where: { id },
      include: { headers: true },
    });
    if (!server) throw new Error("External MCP server not found");
    transport(server.transport);
    if (!server.headers.length) return { ...server, headers: [] };
    const stored = await this.credentials.getJson<StoredExternalMcpHeader[]>(
      externalMcpHeadersCredential(server.id),
    );
    if (!stored) {
      throw new Error(
        "External MCP server headers are not configured; re-enter them in Settings",
      );
    }
    const storedById = new Map(stored.map((header) => [header.id, header]));
    return {
      ...server,
      headers: server.headers.map((header) => {
        const secret = storedById.get(header.id);
        if (!secret?.value) {
          throw new Error(
            `External MCP header ${header.name} is missing; re-enter it in Settings`,
          );
        }
        return { id: header.id, name: header.name, value: secret.value };
      }),
    };
  }

  private async withClient<T>(
    server: ServerWithSecrets,
    action: (client: Client) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const client = new Client({
      name: "ai-development-environment-tools",
      version: "0.1.0",
    });
    const configuredFetch = createConfiguredMcpFetch(server);
    const clientTransport =
      transport(server.transport) === "STREAMABLE_HTTP"
        ? new StreamableHTTPClientTransport(new URL(server.url), {
            fetch: configuredFetch,
          })
        : new SSEClientTransport(new URL(server.url), {
            fetch: configuredFetch,
          });
    let closePromise: Promise<void> | undefined;
    const closeClient = () => {
      closePromise ??= client.close().catch(() => undefined);
      return closePromise;
    };
    let rejectAbort: ((error: unknown) => void) | undefined;
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
          rejectAbort = reject;
        })
      : null;
    const onAbort = () => {
      void closeClient();
      rejectAbort?.(signal?.reason ?? new Error("MCP request cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.connect(clientTransport, {
            timeout: CONNECT_TIMEOUT_MS,
            signal,
          }),
          ...(aborted ? [aborted] : []),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              void closeClient();
              reject(
                new Error(
                  `External MCP server connection timed out after ${CONNECT_TIMEOUT_MS}ms`,
                ),
              );
            }, CONNECT_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      signal?.throwIfAborted();
      return await action(client);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await closeClient();
    }
  }

  private async listRemoteTools(
    server: ServerWithSecrets,
  ): Promise<ToolCatalogItem[]> {
    return this.withClient(server, async (client) => {
      const tools: ToolCatalogItem[] = [];
      const seenCursors = new Set<string>();
      let pageCount = 0;
      let cursor: string | undefined;
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: CONNECT_TIMEOUT_MS,
        });
        pageCount += 1;
        tools.push(
          ...result.tools.map((tool) => ({
            name: tool.name,
            title: tool.title ?? null,
            description: tool.description ?? null,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema ?? null,
            taskSupport: tool.execution?.taskSupport,
            annotations: tool.annotations
              ? {
                  readOnlyHint: tool.annotations.readOnlyHint ?? false,
                  destructiveHint: tool.annotations.destructiveHint ?? false,
                  idempotentHint: tool.annotations.idempotentHint ?? false,
                  openWorldHint: tool.annotations.openWorldHint ?? true,
                }
              : null,
          })),
        );
        const nextCursor = result.nextCursor;
        if (nextCursor) {
          if (seenCursors.has(nextCursor)) {
            throw new Error(
              "External MCP server returned a repeated tools/list cursor",
            );
          }
          if (pageCount >= MAX_TOOLS_LIST_PAGES) {
            throw new Error(
              `External MCP server exceeded the tools/list pagination limit of ${MAX_TOOLS_LIST_PAGES} pages`,
            );
          }
          seenCursors.add(nextCursor);
        }
        cursor = nextCursor;
      } while (cursor);
      if (new Set(tools.map(({ name }) => name)).size !== tools.length)
        throw new Error("External MCP server returned duplicate tool names");
      return tools;
    });
  }
}

export function createConfiguredMcpFetch(
  server: Pick<ServerWithSecrets, "headers">,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(
      server.headers.map((header): [string, string] => [
        header.name,
        header.value,
      ]),
    );
    if (input instanceof Request) {
      input.headers.forEach((value, name) => headers.set(name, value));
    }
    new Headers(init?.headers).forEach((value, name) =>
      headers.set(name, value),
    );
    return fetch(input, { ...init, headers });
  };
}
