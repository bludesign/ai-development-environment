import { describe, expect, test, vi } from "vitest";

import type { CodebasesService } from "./codebases.service";
import {
  CodebaseLookupError,
  CodebaseToolsService,
} from "./codebase-tools.service";

function repository(
  repositoryId: string,
  path: string,
  agentId: string,
  agentName: string,
) {
  const now = new Date();
  return {
    id: repositoryId,
    name: `Repository ${repositoryId}`,
    description: "Description",
    canonicalOrigin: `example.com/${repositoryId}`,
    displayOrigin: `example.com/${repositoryId}`,
    createdAt: now,
    updatedAt: now,
    codebases: [
      {
        id: `codebase-${agentId}`,
        repositoryId,
        agentId,
        folder: path,
        observedOrigin: `git@example.com:${repositoryId}.git`,
        branch: "main",
        headSha: "abc123",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        syncState: "IN_SYNC",
        availability: "AVAILABLE",
        statusError: null,
        lastCheckedAt: now,
        lastFetchedAt: now,
        createdAt: now,
        updatedAt: now,
        agent: {
          id: agentId,
          name: agentName,
          hostname: `${agentId}.local`,
          lastSeenAt: now,
          disconnectedAt: null,
        },
        repository: {},
        jobs: [
          {
            id: `job-${agentId}`,
            kind: "codebase.refresh",
            status: "RUNNING",
          },
        ],
      },
    ],
  };
}

function service(repositories: unknown[]) {
  const codebasesService = {
    overview: vi.fn().mockResolvedValue(repositories),
  } as unknown as CodebasesService;
  return new CodebaseToolsService(codebasesService);
}

describe("CodebaseToolsService", () => {
  test("flattens the ordered overview into the public read model", async () => {
    const tools = service([
      repository("alpha", "/work/alpha", "agent-1", "Studio"),
      repository("beta", "/work/beta", "agent-2", "Laptop"),
    ]);

    const records = await tools.list();

    expect(records.map((record) => record.path)).toEqual([
      "/work/alpha",
      "/work/beta",
    ]);
    expect(records[0]).toMatchObject({
      repository: { name: "Repository alpha" },
      agent: { name: "Studio", connectionStatus: "ONLINE" },
      activeJob: { id: "job-agent-1", status: "RUNNING" },
    });
  });

  test("looks up an exact unique path", async () => {
    const tools = service([
      repository("alpha", "/work/alpha", "agent-1", "Studio"),
    ]);

    await expect(tools.getByPath("/work/alpha")).resolves.toMatchObject({
      id: "codebase-agent-1",
      path: "/work/alpha",
    });
  });

  test("distinguishes missing and ambiguous paths", async () => {
    const tools = service([
      repository("alpha", "/work/shared", "agent-1", "Studio"),
      repository("beta", "/work/shared", "agent-2", "Laptop"),
    ]);

    await expect(tools.getByPath("/missing")).rejects.toMatchObject({
      code: "CODEBASE_NOT_FOUND",
    });
    try {
      await tools.getByPath("/work/shared");
      throw new Error("Expected an ambiguous path error");
    } catch (error) {
      expect(error).toBeInstanceOf(CodebaseLookupError);
      expect(error).toMatchObject({
        code: "AMBIGUOUS_PATH",
        matches: [
          { agentId: "agent-1", hostname: "agent-1.local" },
          { agentId: "agent-2", hostname: "agent-2.local" },
        ],
      });
    }
  });
});
