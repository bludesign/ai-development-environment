// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  credentialHeaders: new Map<
    string,
    Array<{ id: string; name: string; value: string }>
  >(),
  getPrismaClient: vi.fn(),
  httpTransport: vi.fn(),
  listTools: vi.fn(),
  sseTransport: vi.fn(),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

vi.mock("@/services/credentials", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/services/credentials")>();
  return {
    ...original,
    CredentialService: class {
      async isConfigured(descriptor: { ownerId?: string | null }) {
        return mocks.credentialHeaders.has(descriptor.ownerId ?? "");
      }
      async getJson(descriptor: { ownerId?: string | null }) {
        return mocks.credentialHeaders.get(descriptor.ownerId ?? "") ?? null;
      }
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    close = mocks.close;
    listTools = mocks.listTools;
    callTool = mocks.callTool;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(...args: unknown[]) {
      mocks.httpTransport(...args);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    constructor(...args: unknown[]) {
      mocks.sseTransport(...args);
    }
  },
}));

import { ToolsService } from "./tools.service";

const now = new Date();
const httpServer = {
  id: "http-1",
  name: "HTTP server",
  url: "https://http.example.com/mcp",
  transport: "STREAMABLE_HTTP",
  toolNamePrefix: "http_",
  createdAt: now,
  updatedAt: now,
  headers: [{ id: "h1", name: "Authorization", value: "Bearer one" }],
};
const sseServer = {
  ...httpServer,
  id: "sse-1",
  name: "SSE server",
  url: "https://sse.example.com/events",
  transport: "SSE",
  toolNamePrefix: "sse_",
  headers: [],
};

describe("external MCP client transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.listTools.mockResolvedValue({
      tools: [
        {
          name: "search",
          title: "Search",
          description: "Search things",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    mocks.callTool.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
    });
    mocks.credentialHeaders.clear();
    mocks.credentialHeaders.set("http-1", httpServer.headers);
    mocks.getPrismaClient.mockResolvedValue({
      externalMcpServer: {
        findMany: vi.fn().mockResolvedValue([httpServer, sseServer]),
        findUnique: vi
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) =>
            Promise.resolve(where.id === "sse-1" ? sseServer : httpServer),
          ),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("discovers HTTP and SSE servers independently and applies prefixes", async () => {
    const service = new ToolsService({} as never);

    const catalog = await service.catalog();

    expect(mocks.httpTransport).toHaveBeenCalledWith(
      new URL(httpServer.url),
      expect.objectContaining({ fetch: expect.any(Function) }),
    );
    expect(mocks.sseTransport).toHaveBeenCalledWith(
      new URL(sseServer.url),
      expect.objectContaining({ fetch: expect.any(Function) }),
    );
    expect(
      catalog.groups
        .filter(({ source }) => source === "EXTERNAL")
        .map((group) => group.tools[0].name),
    ).toEqual(["http_search", "sse_search"]);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  test("strips the configured prefix before calling a remote tool", async () => {
    const service = new ToolsService({} as never);

    await service.callTool({
      groupId: "external:sse-1",
      name: "sse_search",
      arguments: { query: "repo" },
    });

    expect(mocks.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { query: "repo" } },
      undefined,
      expect.objectContaining({ timeout: 120_000 }),
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  test("freezes mixed identities and routes raw names across prefix changes without losing rich content", async () => {
    const execute = vi.fn(async (_input, operation) => operation());
    const service = new ToolsService({} as never, undefined, {}, undefined, {
      execute,
    } as never);
    const refs = [
      { source: "EXTERNAL" as const, serverId: "http-1", name: "search" },
      { source: "EXTERNAL" as const, serverId: "sse-1", name: "search" },
    ];
    const snapshot = await service.resolveMcpToolReferences(refs);
    expect(new Set(snapshot.tools.map(({ name }) => name)).size).toBe(2);
    expect(
      snapshot.tools.every(({ name }) =>
        /^aide_ext_[a-f0-9]{16}_search$/.test(name),
      ),
    ).toBe(true);
    const entry = snapshot.tools.find(
      ({ reference }) => reference.serverId === "http-1",
    )!;
    const database = await mocks.getPrismaClient();
    database.externalMcpServer.findUnique.mockResolvedValue({
      ...httpServer,
      name: "Renamed",
      toolNamePrefix: "changed_",
    });
    const richResult = {
      content: [
        { type: "image", mimeType: "image/png", data: "base64" },
        {
          type: "resource_link",
          uri: "https://example.test/result",
          name: "Result",
        },
      ],
      structuredContent: { count: 1 },
      _meta: { marker: "retained" },
    };
    mocks.callTool.mockResolvedValue(richResult);
    const controller = new AbortController();
    const context = {
      caller: "agent:one",
      correlationId: "call-1",
      source: "MCP" as const,
    };
    await expect(
      service.callSnapshotTool(
        entry,
        { query: "repo" },
        context,
        null,
        controller.signal,
      ),
    ).resolves.toEqual(richResult);
    expect(mocks.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { query: "repo" } },
      undefined,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "external:http-1",
        toolName: "search",
      }),
      expect.any(Function),
    );
    const current = await service.resolveMcpToolReferences([refs[0]!]);
    expect(current.tools[0]!.name).toBe(entry.name);
    expect(JSON.stringify(snapshot)).not.toContain("Bearer one");
  });

  test("blocks new runs with missing external tools and rejects endpoint drift before forwarding", async () => {
    const service = new ToolsService({} as never, undefined, {}, undefined, {
      execute: async (_input: unknown, operation: () => Promise<unknown>) =>
        operation(),
    } as never);
    const database = await mocks.getPrismaClient();
    database.mcpToolPreset = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "preset-1",
          tools: [],
          externalTools: [{ serverId: "http-1", toolName: "search" }],
        },
      ]),
    };
    const resolved = await service.resolveRunMcpPresets("SESSION", [
      "preset-1",
    ]);
    expect(resolved.toolNames).toHaveLength(1);
    expect(resolved.snapshot?.tools[0]?.reference).toMatchObject({
      serverId: "http-1",
      name: "search",
    });
    mocks.listTools.mockResolvedValue({ tools: [] });
    await expect(
      service.resolveRunMcpPresets("SESSION", ["preset-1"]),
    ).rejects.toThrow("unavailable");
    database.externalMcpServer.findUnique.mockResolvedValue({
      ...httpServer,
      url: "https://changed.example/mcp",
    });
    await expect(
      service.callSnapshotTool(
        resolved.snapshot!.tools[0]!,
        {},
        { caller: "agent:one", correlationId: "one", source: "MCP" },
      ),
    ).rejects.toThrow("endpoint changed");
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  test("shares discovery across bundle entries and preserves failure instead of silently dropping a tool", async () => {
    const service = new ToolsService({} as never);
    const refs = [
      { source: "EXTERNAL" as const, serverId: "http-1", name: "search" },
    ];
    const discovery = new Map();
    await service.resolveMcpToolReferences(refs, discovery);
    await service.resolveMcpToolReferences(refs, discovery);
    expect(mocks.listTools).toHaveBeenCalledOnce();
    mocks.connect.mockRejectedValue(new Error("network unavailable"));
    await expect(service.resolveMcpToolReferences(refs)).rejects.toThrow(
      "unavailable",
    );
  });

  test("closes a slow connection promptly when the scoped request is cancelled", async () => {
    const service = new ToolsService({} as never, undefined, {}, undefined, {
      execute: async (_input: unknown, operation: () => Promise<unknown>) =>
        operation(),
    } as never);
    const snapshot = await service.resolveMcpToolReferences([
      { source: "EXTERNAL", serverId: "http-1", name: "search" },
    ]);
    mocks.connect.mockImplementation(() => new Promise<void>(() => undefined));
    mocks.close.mockClear();
    const controller = new AbortController();
    const call = service.callSnapshotTool(
      snapshot.tools[0]!,
      {},
      { caller: "user:one", correlationId: "one", source: "MCP" },
      undefined,
      controller.signal,
    );
    const rejected = expect(call).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(2));
    controller.abort(new Error("cancelled"));
    await rejected;
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  test("times out and closes a client whose transport startup hangs", async () => {
    vi.useFakeTimers();
    mocks.connect.mockImplementation(() => new Promise<void>(() => undefined));
    const service = new ToolsService({} as never);

    const call = service.callTool({
      groupId: "external:sse-1",
      name: "sse_search",
      arguments: {},
    });
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
    const rejection = expect(call).rejects.toThrow(
      "External MCP server connection timed out after 15000ms",
    );

    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  test("stops tools/list pagination when a cursor repeats", async () => {
    mocks.getPrismaClient.mockResolvedValue({
      externalMcpServer: {
        findMany: vi.fn().mockResolvedValue([httpServer]),
        findUnique: vi.fn().mockResolvedValue(httpServer),
      },
    });
    mocks.listTools.mockResolvedValue({ tools: [], nextCursor: "repeat" });
    const service = new ToolsService({} as never);

    const catalog = await service.catalog();

    expect(
      catalog.groups.find(({ id }) => id === "external:http-1")?.error,
    ).toContain("repeated tools/list cursor");
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  test("limits tools/list pagination with unique cursors", async () => {
    mocks.getPrismaClient.mockResolvedValue({
      externalMcpServer: {
        findMany: vi.fn().mockResolvedValue([httpServer]),
        findUnique: vi.fn().mockResolvedValue(httpServer),
      },
    });
    mocks.listTools.mockImplementation(async () => ({
      tools: [],
      nextCursor: `cursor-${mocks.listTools.mock.calls.length}`,
    }));
    const service = new ToolsService({} as never);

    const catalog = await service.catalog();

    expect(
      catalog.groups.find(({ id }) => id === "external:http-1")?.error,
    ).toContain("tools/list pagination limit of 100 pages");
    expect(mocks.listTools).toHaveBeenCalledTimes(100);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
