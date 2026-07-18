import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as z from "zod/v4";

import { getPrismaClient } from "@/data/prisma-client";
import {
  CodebaseToolsService,
  GetCodebaseInputSchema,
  GetCodebaseOutputSchema,
  GetCodebasesOutputSchema,
} from "@/services/codebases";
import {
  CancelBuildToolInputSchema,
  CancelBuildToolOutputSchema,
  ExportBuildToolInputSchema,
  ExportBuildToolOutputSchema,
  GetBuildConfigurationsInputSchema,
  GetBuildConfigurationsOutputSchema,
  GetBuildDestinationsInputSchema,
  GetBuildDestinationsOutputSchema,
  GetBuildInputSchema,
  GetBuildOutputSchema,
  GetBuildsInputSchema,
  GetBuildsOutputSchema,
  RunBuildToolInputSchema,
  RunBuildToolOutputSchema,
  StartBuildToolInputSchema,
  StartBuildToolOutputSchema,
  type BuildsService,
} from "@/services/builds";

import type {
  ExternalMcpServerInput,
  ExternalMcpServerView,
  ExternalMcpTransport,
  ToolCatalogGroup,
  ToolCatalogItem,
} from "./types";

const BUILTIN_GROUP_ID = "builtin:codebases";
const BUILTIN_BUILDS_GROUP_ID = "builtin:builds";
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

export type ServerWithSecrets = {
  id: string;
  name: string;
  url: string;
  transport: string;
  toolNamePrefix: string;
  headers: Array<{ id: string; name: string; value: string }>;
};

function transport(value: string): ExternalMcpTransport {
  if (value === "STREAMABLE_HTTP" || value === "SSE") return value;
  throw new Error(`Unsupported MCP transport: ${value}`);
}

function view(
  server: ServerWithSecrets & { createdAt: Date; updatedAt: Date },
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
        valueConfigured: Boolean(header.value),
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

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

export class ToolsService {
  constructor(
    private readonly codebaseTools: CodebaseToolsService,
    private readonly builds?: BuildsService,
  ) {}

  async externalServers(): Promise<ExternalMcpServerView[]> {
    const prisma = await getPrismaClient();
    const servers = await prisma.externalMcpServer.findMany({
      orderBy: { name: "asc" },
      include: { headers: true },
    });
    return servers.map(view);
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

    const serverId = id ?? randomUUID();
    await prisma.$transaction(async (transaction) => {
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
      const retainedIds = normalized.headers.flatMap((header) =>
        header.id ? [header.id] : [],
      );
      await transaction.externalMcpServerHeader.deleteMany({
        where: {
          serverId,
          ...(retainedIds.length ? { id: { notIn: retainedIds } } : {}),
        },
      });
      for (const header of normalized.headers) {
        const existingHeader = header.id
          ? existingHeaders.get(header.id)
          : undefined;
        const value = header.value || existingHeader?.value;
        if (!value) throw new Error(`A value is required for ${header.name}`);
        if (header.id) {
          await transaction.externalMcpServerHeader.update({
            where: { id: header.id },
            data: { name: header.name, value },
          });
        } else {
          await transaction.externalMcpServerHeader.create({
            data: {
              id: randomUUID(),
              serverId,
              name: header.name,
              value,
            },
          });
        }
      }
    });
    const saved = await prisma.externalMcpServer.findUniqueOrThrow({
      where: { id: serverId },
      include: { headers: true },
    });
    return view(saved);
  }

  async deleteExternalServer(id: string): Promise<{ id: string }> {
    const prisma = await getPrismaClient();
    const removed = await prisma.externalMcpServer.delete({ where: { id } });
    return { id: removed.id };
  }

  async catalog(): Promise<{ groups: ToolCatalogGroup[] }> {
    const prisma = await getPrismaClient();
    const servers = await prisma.externalMcpServer.findMany({
      orderBy: { name: "asc" },
      include: { headers: true },
    });
    const externalGroups = await Promise.all(
      servers.map(async (server): Promise<ToolCatalogGroup> => {
        try {
          const tools = await this.listRemoteTools(server);
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
            })),
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
          };
        }
      }),
    );
    return {
      groups: [
        this.builtinGroup(),
        ...(this.builds ? [this.builtinBuildsGroup()] : []),
        ...externalGroups,
      ],
    };
  }

  async callTool(input: {
    groupId: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown> {
    if (input.groupId === BUILTIN_GROUP_ID) {
      if (input.name === "get_codebases") {
        const structuredContent = GetCodebasesOutputSchema.parse({
          codebases: await this.codebaseTools.list(),
        });
        return this.toolResult(structuredContent);
      }
      if (input.name === "get_codebase") {
        const args = GetCodebaseInputSchema.parse(input.arguments);
        const structuredContent = GetCodebaseOutputSchema.parse({
          codebase: await this.codebaseTools.getByPath(args.path),
        });
        return this.toolResult(structuredContent);
      }
      throw new Error(`Unknown built-in tool: ${input.name}`);
    }
    if (input.groupId === BUILTIN_BUILDS_GROUP_ID) {
      return this.callBuildTool(input.name, input.arguments);
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

  private toolResult(structuredContent: Record<string, unknown>) {
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

  private builtinGroup(): ToolCatalogGroup {
    return {
      id: BUILTIN_GROUP_ID,
      name: "Codebases",
      source: "BUILTIN",
      transport: null,
      url: null,
      error: null,
      tools: [
        {
          name: "get_codebases",
          title: "Get codebases",
          description:
            "List basic information for every registered codebase checkout.",
          inputSchema: jsonSchema(z.object({})),
          outputSchema: jsonSchema(GetCodebasesOutputSchema),
        },
        {
          name: "get_codebase",
          title: "Get codebase",
          description:
            "Get one registered codebase checkout by its exact folder path.",
          inputSchema: jsonSchema(GetCodebaseInputSchema),
          outputSchema: jsonSchema(GetCodebaseOutputSchema),
        },
      ],
    };
  }

  private builtinBuildsGroup(): ToolCatalogGroup {
    const tool = (
      name: string,
      title: string,
      description: string,
      inputSchema: z.ZodType,
      outputSchema: z.ZodType,
    ) => ({
      name,
      title,
      description,
      inputSchema: jsonSchema(inputSchema),
      outputSchema: jsonSchema(outputSchema),
    });
    return {
      id: BUILTIN_BUILDS_GROUP_ID,
      name: "Builds",
      source: "BUILTIN",
      transport: null,
      url: null,
      error: null,
      tools: [
        tool(
          "get_builds",
          "Get builds",
          "List iOS build records.",
          GetBuildsInputSchema,
          GetBuildsOutputSchema,
        ),
        tool(
          "get_build",
          "Get build",
          "Get a build with sanitized logs.",
          GetBuildInputSchema,
          GetBuildOutputSchema,
        ),
        tool(
          "get_build_configurations",
          "Get build configurations",
          "List build configurations for a worktree.",
          GetBuildConfigurationsInputSchema,
          GetBuildConfigurationsOutputSchema,
        ),
        tool(
          "get_build_destinations",
          "Get build destinations",
          "Inspect compatible destinations.",
          GetBuildDestinationsInputSchema,
          GetBuildDestinationsOutputSchema,
        ),
        tool(
          "start_build",
          "Start build",
          "Queue an iOS build.",
          StartBuildToolInputSchema,
          StartBuildToolOutputSchema,
        ),
        tool(
          "cancel_build",
          "Cancel build",
          "Cancel an active build.",
          CancelBuildToolInputSchema,
          CancelBuildToolOutputSchema,
        ),
        tool(
          "run_build",
          "Run build",
          "Install and launch without rebuilding.",
          RunBuildToolInputSchema,
          RunBuildToolOutputSchema,
        ),
        tool(
          "export_build_archive",
          "Export build archive",
          "Export an archive to a local IPA folder.",
          ExportBuildToolInputSchema,
          ExportBuildToolOutputSchema,
        ),
      ],
    };
  }

  private async callBuildTool(
    name: string,
    rawArguments: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.builds) throw new Error("Build tools are unavailable");
    const builds = this.builds;
    if (name === "get_builds") {
      const input = GetBuildsInputSchema.parse(rawArguments);
      const page = await builds.builds(input);
      return this.toolResult(
        GetBuildsOutputSchema.parse({
          builds: page.items,
          nextCursor: page.nextCursor,
        }),
      );
    }
    if (name === "get_build") {
      const input = GetBuildInputSchema.parse(rawArguments);
      const build = await builds.getBuild(input.buildId);
      if (!build) throw new Error("Build not found");
      return this.toolResult(
        GetBuildOutputSchema.parse({
          build,
          logs: await builds.logs(
            input.buildId,
            input.afterSequence,
            input.logLimit,
          ),
        }),
      );
    }
    if (name === "get_build_configurations") {
      const input = GetBuildConfigurationsInputSchema.parse(rawArguments);
      return this.toolResult(
        GetBuildConfigurationsOutputSchema.parse({
          project: await builds.projectForWorktree(input.worktreeId),
        }),
      );
    }
    if (name === "get_build_destinations") {
      const input = GetBuildDestinationsInputSchema.parse(rawArguments);
      return this.toolResult(
        GetBuildDestinationsOutputSchema.parse({
          destinations:
            "buildId" in input
              ? await builds.destinationsForBuild(
                  input.buildId,
                  input.requestId,
                )
              : await builds.destinations(input as never),
        }),
      );
    }
    if (name === "start_build") {
      const input = StartBuildToolInputSchema.parse(rawArguments);
      return this.toolResult(
        StartBuildToolOutputSchema.parse({
          build: await builds.startBuild(input as never),
        }),
      );
    }
    if (name === "cancel_build") {
      const input = CancelBuildToolInputSchema.parse(rawArguments);
      return this.toolResult(
        CancelBuildToolOutputSchema.parse({
          build: await builds.cancelBuild(input.buildId),
        }),
      );
    }
    if (name === "run_build") {
      const input = RunBuildToolInputSchema.parse(rawArguments);
      return this.toolResult(
        RunBuildToolOutputSchema.parse({
          deployments: await builds.runBuild(input),
        }),
      );
    }
    if (name === "export_build_archive") {
      const input = ExportBuildToolInputSchema.parse(rawArguments);
      return this.toolResult(
        ExportBuildToolOutputSchema.parse({
          export: await builds.exportArchive(input),
        }),
      );
    }
    throw new Error(`Unknown built-in build tool: ${name}`);
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
    return server;
  }

  private async withClient<T>(
    server: ServerWithSecrets,
    action: (client: Client) => Promise<T>,
  ): Promise<T> {
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
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.connect(clientTransport, { timeout: CONNECT_TIMEOUT_MS }),
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
      return await action(client);
    } finally {
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
