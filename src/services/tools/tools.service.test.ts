import { afterEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  createConfiguredMcpFetch,
  normalizeExternalMcpServerInput,
  ToolsService,
} from "./tools.service";
import type { BuildsService } from "@/services/builds";
import { CREDENTIALS } from "@/services/credentials";

afterEach(() => vi.unstubAllGlobals());

describe("external MCP configuration", () => {
  test("exposes and invokes the built-in Builds group", async () => {
    getPrismaClient.mockResolvedValue({
      externalMcpServer: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const startBuild = vi.fn().mockResolvedValue({
      id: "build-1",
      status: "QUEUED",
    });
    const service = new ToolsService(
      {} as never,
      {
        startBuild,
      } as unknown as BuildsService,
    );

    const catalog = await service.catalog();

    expect(catalog.groups.map(({ id }) => id)).toEqual([
      "builtin:codebases",
      "builtin:builds",
      "builtin:tool-administration",
    ]);
    expect(catalog.groups[1]?.tools.map(({ name }) => name)).toEqual([
      "get_builds",
      "get_build",
      "get_build_configurations",
      "get_build_destinations",
      "start_build",
      "import_coverage_report",
      "cancel_build",
      "run_build",
      "export_build_archive",
      "get_build_project",
      "create_build_project",
      "save_build_configuration",
      "delete_build_configuration",
      "discover_build_sources",
      "inspect_build_source",
      "get_build_scripts",
      "save_build_script",
      "delete_build_script",
      "rebuild_build",
      "delete_builds",
      "get_build_reports",
      "generate_build_report",
      "start_worktree_coverage",
      "get_worktree_coverage",
    ]);
    await expect(
      service.callTool({
        groupId: "builtin:builds",
        name: "start_build",
        arguments: {
          worktreeId: "worktree-1",
          configurationId: "configuration-1",
          destination: { type: "SIMULATOR", id: "SIM-1" },
          requestId: "request-1",
        },
      }),
    ).resolves.toMatchObject({
      structuredContent: { build: { id: "build-1" } },
    });
    expect(startBuild).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "request-1", scriptIds: [] }),
    );
  });

  test("filters and guards provider cache tools with the primary token", async () => {
    getPrismaClient.mockResolvedValue({
      externalMcpServer: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const cachedEntries = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    const credentials = {
      isConfigured: vi.fn(
        async (descriptor: { id: string }) =>
          descriptor.id === CREDENTIALS.gitlabAccessToken.id,
      ),
    };
    const service = new ToolsService(
      {} as never,
      undefined,
      {
        cacheServer: {} as never,
        jira: {} as never,
        github: {} as never,
        gitlab: { cachedEntries } as never,
      },
      credentials as never,
    );

    const catalog = await service.catalog();
    expect(catalog.groups.map(({ id }) => id)).toContain("builtin:gitlab");
    expect(catalog.groups.map(({ id }) => id)).not.toContain("builtin:github");
    const cache = catalog.groups.find(
      ({ id }) => id === "builtin:cache-administration",
    );
    expect(cache?.children.map(({ id }) => id)).toContain(
      "builtin:cache-administration:gitlab",
    );
    expect(cache?.children.map(({ id }) => id)).not.toContain(
      "builtin:cache-administration:github",
    );

    await expect(
      service.callTool({
        groupId: "builtin:cache-administration:github",
        name: "get_github_cached_entries",
        arguments: {},
      }),
    ).rejects.toThrow(/GitHub tools are unavailable/);
    await expect(
      service.callTool({
        groupId: "builtin:cache-administration:gitlab",
        name: "get_gitlab_cached_entries",
        arguments: {},
      }),
    ).resolves.toMatchObject({
      structuredContent: { page: { total: 0 } },
    });
    expect(cachedEntries).toHaveBeenCalledWith(100, 0);
  });

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
        },
      ],
    };
    let storedHeaders = [
      {
        id: "header-1",
        name: "Authorization",
        value: "Bearer secret",
      },
    ];
    const transaction = {
      externalMcpServer: {
        upsert: vi.fn(async ({ update }: { update: Partial<typeof state> }) => {
          Object.assign(state, update);
          return state;
        }),
      },
      externalMcpServerHeader: {
        deleteMany: vi.fn(async () => {
          state.headers = [];
          return { count: 1 };
        }),
        createMany: vi.fn(async ({ data }: { data: typeof state.headers }) => {
          state.headers = data;
          return { count: data.length };
        }),
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
    const credentialService = {
      isConfigured: vi.fn(async () => storedHeaders.length > 0),
      getJson: vi.fn(async () => storedHeaders),
      setJson: vi.fn(
        async (
          _descriptor: unknown,
          value: typeof storedHeaders,
          mutation: (transactionValue: object) => Promise<void>,
        ) => {
          await mutation(transaction);
          storedHeaders = value;
        },
      ),
      delete: vi.fn(
        async (
          _descriptor: unknown,
          mutation: (transactionValue: object) => Promise<void>,
        ) => {
          await mutation(transaction);
          storedHeaders = [];
        },
      ),
    };
    const service = new ToolsService(
      {} as never,
      undefined,
      {},
      credentialService as never,
    );

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
    });
    expect(state.headers[0]).not.toHaveProperty("value");
    expect(storedHeaders[0]).toMatchObject({
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
    expect(storedHeaders).toEqual([]);
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

describe("MCP tool presets", () => {
  test("creates, replaces membership on edit, and deletes presets", async () => {
    const service = new ToolsService({} as never);
    const [first, second] = service.builtInTools
      .definitions()
      .slice(0, 2)
      .map(({ name }) => name);
    const now = new Date("2026-07-26T12:00:00.000Z");
    const state = {
      id: "",
      name: "",
      description: "",
      iconKey: "wrench",
      enabledForPlans: false,
      enabledForSessions: false,
      createdAt: now,
      updatedAt: now,
      tools: [] as Array<{ toolName: string }>,
    };
    const transaction = {
      mcpToolPreset: {
        upsert: vi.fn(
          async ({
            create,
            update,
          }: {
            create: typeof state;
            update: Partial<typeof state>;
          }) => {
            Object.assign(state, state.id ? update : create);
            return state;
          },
        ),
      },
      mcpToolPresetTool: {
        deleteMany: vi.fn(async () => {
          state.tools = [];
          return { count: 0 };
        }),
        createMany: vi.fn(
          async ({ data }: { data: Array<{ toolName: string }> }) => {
            state.tools = data.map(({ toolName }) => ({ toolName }));
            return { count: data.length };
          },
        ),
      },
    };
    const remove = vi.fn(async () => state);
    getPrismaClient.mockResolvedValue({
      mcpToolPreset: {
        findMany: vi.fn(async () =>
          state.id ? [{ id: state.id, name: state.name }] : [],
        ),
        findUnique: vi.fn(async () => (state.id ? state : null)),
        findUniqueOrThrow: vi.fn(async () => state),
        delete: remove,
      },
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    });

    const created = await service.createMcpToolPreset({
      name: "Reader",
      description: "Read only",
      iconKey: "code",
      enabledForPlans: true,
      enabledForSessions: false,
      toolNames: [first],
    });
    expect(created).toMatchObject({
      name: "Reader",
      toolNames: [first],
      enabledForPlans: true,
    });

    const updated = await service.updateMcpToolPreset(created.id, {
      name: "Reader and lookup",
      description: "",
      iconKey: "sparkles",
      enabledForPlans: true,
      enabledForSessions: true,
      toolNames: [second],
    });
    expect(updated).toMatchObject({
      name: "Reader and lookup",
      toolNames: [second],
      enabledForSessions: true,
    });

    await expect(service.deleteMcpToolPreset(created.id)).resolves.toEqual({
      id: created.id,
    });
    expect(remove).toHaveBeenCalledWith({ where: { id: created.id } });
  });

  test("validates non-empty, supported, duplicate-free built-in membership", async () => {
    const service = new ToolsService({} as never);
    const toolName = service.builtInTools.definitions()[0]!.name;
    const base = {
      name: "Read only",
      description: "",
      iconKey: "wrench",
      enabledForPlans: true,
      enabledForSessions: false,
      toolNames: [toolName],
    };

    await expect(
      service.createMcpToolPreset({ ...base, toolNames: [] }),
    ).rejects.toThrow(/at least one/);
    await expect(
      service.createMcpToolPreset({ ...base, iconKey: "unknown" }),
    ).rejects.toThrow(/icon/);
    await expect(
      service.createMcpToolPreset({
        ...base,
        toolNames: [toolName, toolName],
      }),
    ).rejects.toThrow(/duplicates/);
    await expect(
      service.createMcpToolPreset({ ...base, toolNames: ["future_tool"] }),
    ).rejects.toThrow(/Unknown built-in tool/);
  });

  test("enforces case-insensitive preset names", async () => {
    const service = new ToolsService({} as never);
    const toolName = service.builtInTools.definitions()[0]!.name;
    getPrismaClient.mockResolvedValue({
      mcpToolPreset: {
        findMany: vi.fn().mockResolvedValue([{ id: "preset-1", name: "Safe" }]),
      },
    });

    await expect(
      service.createMcpToolPreset({
        name: " safe ",
        description: "",
        iconKey: "wrench",
        enabledForPlans: false,
        enabledForSessions: false,
        toolNames: [toolName],
      }),
    ).rejects.toThrow(/already exists/);
  });

  test("deduplicates selections, filters eligibility and stale tools, and unions membership", async () => {
    const service = new ToolsService({} as never);
    const [first, second] = service.builtInTools
      .definitions()
      .slice(0, 2)
      .map(({ name }) => name);
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "preset-1",
        tools: [{ toolName: first }, { toolName: "removed_tool" }],
      },
      { id: "preset-2", tools: [{ toolName: first }, { toolName: second }] },
    ]);
    getPrismaClient.mockResolvedValue({ mcpToolPreset: { findMany } });

    await expect(
      service.resolveRunMcpPresets("SESSION", [
        "preset-1",
        "missing",
        "preset-1",
        "preset-2",
      ]),
    ).resolves.toEqual({
      presetIds: ["preset-1", "preset-2"],
      toolNames: [first, second].sort(),
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["preset-1", "missing", "preset-2"] },
          enabledForSessions: true,
        },
      }),
    );
  });

  test("serves surviving preset tools and enforces run ownership for snapshots", async () => {
    const service = new ToolsService({} as never);
    const toolName = service.builtInTools.definitions()[0]!.name;
    getPrismaClient.mockResolvedValue({
      mcpToolPreset: {
        findUnique: vi.fn().mockResolvedValue({
          id: "preset-1",
          tools: [{ toolName }, { toolName: "removed_tool" }],
        }),
      },
      agentRun: {
        findUnique: vi.fn().mockResolvedValue({
          agentId: "agent-1",
          repositoryId: "repository-1",
          mcpToolNamesJson: JSON.stringify([toolName, "removed_tool"]),
        }),
      },
    });

    await expect(service.mcpPresetToolNames("preset-1")).resolves.toEqual([
      toolName,
    ]);
    await expect(service.mcpRunToolNames("run-1", "agent-2")).resolves.toEqual({
      status: "FORBIDDEN",
    });
    await expect(service.mcpRunToolNames("run-1", "agent-1")).resolves.toEqual({
      status: "OK",
      repositoryId: "repository-1",
      toolNames: [toolName],
    });
  });

  test("scopes preparation tools to the run repository", async () => {
    const repositoryPreparations = vi.fn().mockResolvedValue([]);
    const service = new ToolsService({} as never, undefined, {
      codebases: { repositoryPreparations } as never,
    });

    await expect(
      service.callRunBuiltInTool(
        "get_codebase_repository_preparations",
        { repositoryId: "repository-1" },
        "repository-1",
      ),
    ).resolves.toMatchObject({ structuredContent: { preparations: [] } });
    await expect(
      service.callRunBuiltInTool(
        "get_codebase_repository_preparations",
        { repositoryId: "repository-2" },
        "repository-1",
      ),
    ).rejects.toThrow("run repository");
    expect(repositoryPreparations).toHaveBeenCalledTimes(1);
  });
});
