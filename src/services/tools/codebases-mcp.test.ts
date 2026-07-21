import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { CodebaseToolsService } from "@/services/codebases";
import type { BuildsService } from "@/services/builds";
import type { TelemetryService } from "@/services/telemetry";
import type { PushNotificationsService } from "@/services/push-notifications";
import type { AgentControlService } from "@/services/agent-control";

import { createBuiltInToolRegistry } from "./builtin-tools";
import {
  createBuiltInMcpServer,
  createCodebasesMcpServer,
} from "./codebases-mcp";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function clientFor(
  service: CodebaseToolsService,
  builds?: BuildsService,
) {
  const server = createCodebasesMcpServer(service, builds);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("codebases MCP server", () => {
  test("lists and calls both read-only tools", async () => {
    const record = {
      id: "codebase-1",
      path: "/work/repo",
      observedOrigin: "git@example.com:repo.git",
      branch: "main",
      headSha: "abc",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      syncState: "IN_SYNC" as const,
      availability: "AVAILABLE" as const,
      statusError: null,
      lastCheckedAt: null,
      lastFetchedAt: null,
      repository: {
        id: "repository-1",
        name: "Repo",
        description: "",
        canonicalOrigin: "example.com/repo",
        displayOrigin: "example.com/repo",
      },
      agent: {
        id: "agent-1",
        name: "Studio",
        hostname: "studio.local",
        connectionStatus: "ONLINE" as const,
      },
      activeJob: null,
    };
    const service = {
      list: vi.fn().mockResolvedValue([record]),
      getByPath: vi.fn().mockResolvedValue(record),
    } as unknown as CodebaseToolsService;
    const client = await clientFor(service);

    const catalog = await client.listTools();
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "get_codebases",
      "get_codebase",
    ]);
    expect(catalog.tools[0].annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });

    const listResult = await client.callTool({
      name: "get_codebases",
      arguments: {},
    });
    expect(listResult).toMatchObject({
      structuredContent: { codebases: [{ path: "/work/repo" }] },
    });

    const getResult = await client.callTool({
      name: "get_codebase",
      arguments: { path: "/work/repo" },
    });
    expect(service.getByPath).toHaveBeenCalledWith("/work/repo");
    expect(getResult).toMatchObject({
      structuredContent: { codebase: { id: "codebase-1" } },
    });
  });

  test("returns an MCP tool error for invalid input", async () => {
    const service = {
      list: vi.fn(),
      getByPath: vi.fn(),
    } as unknown as CodebaseToolsService;
    const client = await clientFor(service);

    await expect(
      client.callTool({ name: "get_codebase", arguments: {} }),
    ).resolves.toMatchObject({ isError: true });
    expect(service.getByPath).not.toHaveBeenCalled();
  });

  test("lists and invokes the complete Builds tool group", async () => {
    const codebases = {
      list: vi.fn().mockResolvedValue([]),
      getByPath: vi.fn(),
    } as unknown as CodebaseToolsService;
    const build = { id: "build-1", status: "QUEUED" };
    const builds = {
      builds: vi.fn().mockResolvedValue({ items: [build], nextCursor: null }),
      getBuild: vi.fn().mockResolvedValue(build),
      logs: vi.fn().mockResolvedValue([{ sequence: 0, message: "sanitized" }]),
      projectForWorktree: vi.fn().mockResolvedValue({ id: "project-1" }),
      destinations: vi.fn().mockResolvedValue([
        {
          type: "SIMULATOR",
          id: "SIM-1",
          name: "iPhone 17 Pro",
        },
      ]),
      destinationsForBuild: vi.fn().mockResolvedValue([
        {
          type: "SIMULATOR",
          id: "SIM-1",
          name: "iPhone 17 Pro",
        },
      ]),
      startBuild: vi.fn().mockResolvedValue(build),
      cancelBuild: vi.fn().mockResolvedValue({ ...build, status: "CANCELLED" }),
      runBuild: vi.fn().mockResolvedValue([{ id: "deployment-1" }]),
      exportArchive: vi.fn().mockResolvedValue({ id: "export-1" }),
    } as unknown as BuildsService;
    const client = await clientFor(codebases, builds);

    const catalog = await client.listTools();
    expect(catalog.tools.map(({ name }) => name)).toEqual([
      "get_codebases",
      "get_codebase",
      "get_builds",
      "get_build",
      "get_build_configurations",
      "get_build_destinations",
      "start_build",
      "cancel_build",
      "run_build",
      "export_build_archive",
    ]);
    expect(
      catalog.tools.find(({ name }) => name === "start_build")?.annotations,
    ).toMatchObject({ readOnlyHint: false, idempotentHint: true });

    await expect(
      client.callTool({
        name: "start_build",
        arguments: {
          worktreeId: "worktree-1",
          configurationId: "configuration-1",
          destination: {
            type: "SIMULATOR",
            id: "SIM-1",
            name: "iPhone 17 Pro",
          },
          requestId: "request-1",
        },
      }),
    ).resolves.toMatchObject({ structuredContent: { build } });
    expect(builds.startBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: "worktree-1",
        requestId: "request-1",
        scriptIds: [],
      }),
    );

    await expect(
      client.callTool({
        name: "get_build",
        arguments: {
          buildId: "build-1",
          afterLogId: "log-4",
          logLimit: 10,
        },
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        build,
        logs: [{ sequence: 0, message: "sanitized" }],
      },
    });
    expect(builds.logs).toHaveBeenCalledWith("build-1", "log-4", 10);

    await expect(
      client.callTool({
        name: "get_build_destinations",
        arguments: { buildId: "build-1", requestId: "destinations-1" },
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        destinations: [{ id: "SIM-1" }],
      },
    });
    expect(builds.destinationsForBuild).toHaveBeenCalledWith(
      "build-1",
      "destinations-1",
    );

    await expect(
      client.callTool({
        name: "cancel_build",
        arguments: { buildId: "build-1" },
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  test("lists the nested catalog as flat MCP tools and invokes a child tool", async () => {
    const timeline = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      matchingCount: 0,
      totalCount: 0,
    });
    const registry = createBuiltInToolRegistry({
      codebaseTools: {
        list: vi.fn().mockResolvedValue([]),
      } as unknown as CodebaseToolsService,
      codebases: {} as never,
      builds: {} as never,
      telemetry: { timeline } as unknown as TelemetryService,
      pushNotifications: {} as PushNotificationsService,
      agents: {} as AgentControlService,
    });
    const server = createBuiltInMcpServer(registry);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });

    const catalog = await client.listTools();
    expect(catalog.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "get_codebases",
        "get_builds",
        "get_unified_events",
        "get_console_logs",
        "get_push_notification_history",
        "get_agents",
      ]),
    );
    await expect(
      client.callTool({ name: "get_console_logs", arguments: {} }),
    ).resolves.toMatchObject({ structuredContent: { items: [] } });
    expect(timeline).toHaveBeenCalledWith(
      expect.objectContaining({ view: "CONSOLE" }),
    );
  });
});
