import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { CodebaseToolsService } from "@/services/codebases";

import { createCodebasesMcpServer } from "./codebases-mcp";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function clientFor(service: CodebaseToolsService) {
  const server = createCodebasesMcpServer(service);
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
});
