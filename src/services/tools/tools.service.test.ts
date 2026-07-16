import { afterEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  createConfiguredMcpFetch,
  normalizeExternalMcpServerInput,
  ToolsService,
} from "./tools.service";

afterEach(() => vi.unstubAllGlobals());

describe("external MCP configuration", () => {
  test("preserves existing write-only header values and deletes omitted rows", async () => {
    const now = new Date();
    const state = {
      id: "server-1",
      name: "Example",
      url: "https://example.com/mcp",
      transport: "STREAMABLE_HTTP",
      toolNamePrefix: "",
      createdAt: now,
      updatedAt: now,
      headers: [
        {
          id: "header-1",
          serverId: "server-1",
          name: "Authorization",
          value: "Bearer secret",
        },
      ],
    };
    const transaction = {
      externalMcpServer: {
        upsert: vi.fn(async ({ update }: { update: Partial<typeof state> }) => {
          Object.assign(state, update);
          return state;
        }),
      },
      externalMcpServerHeader: {
        deleteMany: vi.fn(
          async ({ where }: { where: { id?: { notIn?: string[] } } }) => {
            const retained = where.id?.notIn;
            state.headers = retained
              ? state.headers.filter((header) => retained.includes(header.id))
              : [];
            return { count: 1 };
          },
        ),
        update: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string };
            data: { name: string; value: string };
          }) => {
            const header = state.headers.find((item) => item.id === where.id);
            if (header) Object.assign(header, data);
            return header;
          },
        ),
        create: vi.fn(),
      },
    };
    getPrismaClient.mockResolvedValue({
      externalMcpServer: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: state.id, name: state.name }]),
        findUnique: vi.fn().mockImplementation(async () => state),
        findUniqueOrThrow: vi.fn().mockImplementation(async () => state),
      },
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    });
    const service = new ToolsService({} as never);

    const saved = await service.updateExternalServer("server-1", {
      name: "Example",
      url: "https://example.com/mcp",
      transport: "STREAMABLE_HTTP",
      headers: [
        {
          id: "header-1",
          name: "X-Authorization",
          value: null,
        },
      ],
    });

    expect(state.headers[0]).toMatchObject({
      name: "X-Authorization",
      value: "Bearer secret",
    });
    expect(saved.headers).toEqual([
      {
        id: "header-1",
        name: "X-Authorization",
        valueConfigured: true,
      },
    ]);
    expect(saved).not.toHaveProperty("headers.0.value");

    await service.updateExternalServer("server-1", {
      name: "Example",
      url: "https://example.com/mcp",
      transport: "STREAMABLE_HTTP",
      headers: [],
    });
    expect(state.headers).toEqual([]);
  });

  test("normalizes supported URLs, transports, prefixes, and headers", () => {
    expect(
      normalizeExternalMcpServerInput({
        name: " Example ",
        url: "https://example.com/mcp",
        transport: "STREAMABLE_HTTP",
        toolNamePrefix: "example_",
        headers: [{ name: "Authorization", value: "Bearer secret" }],
      }),
    ).toMatchObject({
      name: "Example",
      url: "https://example.com/mcp",
      transport: "STREAMABLE_HTTP",
      toolNamePrefix: "example_",
      headers: [{ name: "Authorization", value: "Bearer secret" }],
    });
  });

  test("rejects unsafe URLs and transport-managed or duplicate headers", () => {
    expect(() =>
      normalizeExternalMcpServerInput({
        name: "Example",
        url: "file:///tmp/mcp",
        transport: "SSE",
        headers: [],
      }),
    ).toThrow(/HTTP or HTTPS/);

    expect(() =>
      normalizeExternalMcpServerInput({
        name: "Example",
        url: "https://example.com/mcp",
        transport: "SSE",
        headers: [{ name: "Content-Type", value: "text/plain" }],
      }),
    ).toThrow(/managed by the MCP transport/);

    expect(() =>
      normalizeExternalMcpServerInput({
        name: "Example",
        url: "https://example.com/mcp",
        transport: "SSE",
        headers: [
          { name: "X-Token", value: "one" },
          { name: "x-token", value: "two" },
        ],
      }),
    ).toThrow(/Duplicate header/);
  });

  test("injects saved headers while preserving SDK-managed request headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const configuredFetch = createConfiguredMcpFetch({
      headers: [
        {
          id: "header-1",
          name: "Authorization",
          value: "Bearer secret",
        },
      ],
    });

    await configuredFetch("https://example.com/mcp", {
      headers: { accept: "application/json, text/event-stream" },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
  });
});
