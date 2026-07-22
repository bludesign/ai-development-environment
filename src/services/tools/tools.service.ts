import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import type { BuildsService } from "@/services/builds";
import type { CodebaseToolsService } from "@/services/codebases";
import {
  CredentialService,
  externalMcpHeadersCredential,
} from "@/services/credentials";

import {
  createBuiltInToolRegistry,
  type BuiltInToolRegistry,
  type BuiltInToolServices,
} from "./builtin-tools";

import type {
  ExternalMcpServerInput,
  ExternalMcpServerView,
  ExternalMcpTransport,
  ToolCatalogGroup,
  ToolCatalogItem,
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

export type ServerWithSecrets = {
  id: string;
  name: string;
  url: string;
  transport: string;
  toolNamePrefix: string;
  headers: Array<{ id: string; name: string; value: string }>;
};

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

export class ToolsService {
  readonly builtInTools: BuiltInToolRegistry;

  constructor(
    codebaseTools: CodebaseToolsService,
    builds?: BuildsService,
    additional: Omit<BuiltInToolServices, "codebaseTools" | "builds"> = {},
    private readonly credentials = new CredentialService(),
  ) {
    this.builtInTools = createBuiltInToolRegistry({
      codebaseTools,
      builds,
      ...additional,
    });
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
    if (headers.length) {
      await this.credentials.setJson(descriptor, headers, saveMetadata);
    } else {
      await this.credentials.delete(descriptor, saveMetadata);
    }
    const saved = await prisma.externalMcpServer.findUniqueOrThrow({
      where: { id: serverId },
      include: { headers: true },
    });
    return view(saved, true);
  }

  async deleteExternalServer(id: string): Promise<{ id: string }> {
    await this.credentials.delete(
      externalMcpHeadersCredential(id),
      async (transaction) => {
        await transaction.externalMcpServer.delete({ where: { id } });
      },
    );
    return { id };
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
          const tools = await this.listRemoteTools(
            await this.externalServerWithSecrets(server.id),
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
    return {
      groups: [...this.builtInTools.catalog(), ...externalGroups],
    };
  }

  async callTool(input: {
    groupId: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown> {
    if (this.builtInTools.hasGroup(input.groupId)) {
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
