// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  getPrismaClient: vi.fn(),
  httpTransport: vi.fn(),
  listTools: vi.fn(),
  sseTransport: vi.fn(),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

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
    expect(catalog.groups.slice(1).map((group) => group.tools[0].name)).toEqual(
      ["http_search", "sse_search"],
    );
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
      },
    });
    mocks.listTools.mockResolvedValue({ tools: [], nextCursor: "repeat" });
    const service = new ToolsService({} as never);

    const catalog = await service.catalog();

    expect(catalog.groups[1].error).toContain("repeated tools/list cursor");
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  test("limits tools/list pagination with unique cursors", async () => {
    mocks.getPrismaClient.mockResolvedValue({
      externalMcpServer: {
        findMany: vi.fn().mockResolvedValue([httpServer]),
      },
    });
    mocks.listTools.mockImplementation(async () => ({
      tools: [],
      nextCursor: `cursor-${mocks.listTools.mock.calls.length}`,
    }));
    const service = new ToolsService({} as never);

    const catalog = await service.catalog();

    expect(catalog.groups[1].error).toContain(
      "tools/list pagination limit of 100 pages",
    );
    expect(mocks.listTools).toHaveBeenCalledTimes(100);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
