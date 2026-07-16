import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  CODEBASE_FETCH_JOB_KIND,
  type CodebaseSnapshot,
} from "@ai-development-environment/agent-contract/codebases";
import type { AgentControlService } from "@/services/agent-control";

import { CodebasesService } from "./codebases.service";

function control() {
  return {
    registerCompletionHandler: vi.fn(),
    createJob: vi.fn(async (input) => ({ id: `job-${input.codebaseId}` })),
  } as unknown as AgentControlService;
}

const snapshot: CodebaseSnapshot = {
  folder: "/repo",
  observedOrigin: "git@example.com:new/repo.git",
  canonicalOrigin: "example.com/new/repo",
  displayOrigin: "example.com/new/repo",
  branch: "main",
  headSha: "abc",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  syncState: "IN_SYNC",
  availability: "AVAILABLE",
  error: null,
  checkedAt: new Date(10).toISOString(),
  fetchedAt: new Date(1).toISOString(),
  linkedWorktree: false,
};

describe("CodebasesService", () => {
  beforeEach(() => vi.clearAllMocks());

  test("keeps fetch time monotonic and marks an unconfirmed origin change", async () => {
    const current = {
      id: "codebase-1",
      agentId: "agent-1",
      repositoryId: "repository-1",
      observedOrigin: "git@example.com:old/repo.git",
      lastFetchedAt: new Date(5),
      repository: { canonicalOrigin: "example.com/old/repo" },
    };
    const prisma = {
      codebase: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: vi.fn(async ({ data }) => ({
          ...current,
          ...data,
          agent: {},
          repository: current.repository,
          jobs: [],
        })),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CodebasesService(control());

    await service.report("agent-1", [{ codebaseId: "codebase-1", snapshot }]);

    expect(prisma.codebase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          availability: "ORIGIN_MISMATCH",
          lastFetchedAt: new Date(5),
          statusError: "Origin changed to example.com/new/repo",
        }),
      }),
    );
  });

  test("queues bulk fetch only for online capable available codebases", async () => {
    const now = new Date();
    const capable = {
      lastSeenAt: now,
      disconnectedAt: null,
      capabilitiesJson: JSON.stringify([CODEBASE_FETCH_JOB_KIND]),
    };
    const prisma = {
      codebase: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "ready",
            agentId: "agent-1",
            folder: "/ready",
            availability: "AVAILABLE",
            agent: capable,
            repository: { canonicalOrigin: "example.com/ready" },
          },
          {
            id: "offline",
            agentId: "agent-2",
            folder: "/offline",
            availability: "AVAILABLE",
            agent: { ...capable, lastSeenAt: new Date(0) },
            repository: { canonicalOrigin: "example.com/offline" },
          },
          {
            id: "mismatch",
            agentId: "agent-1",
            folder: "/mismatch",
            availability: "ORIGIN_MISMATCH",
            agent: capable,
            repository: { canonicalOrigin: "example.com/mismatch" },
          },
        ]),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const agentControl = control();
    const service = new CodebasesService(agentControl);

    const result = await service.runOperation(
      CODEBASE_FETCH_JOB_KIND,
      ["ready", "offline", "mismatch"],
      "request-1",
    );

    expect(agentControl.createJob).toHaveBeenCalledTimes(1);
    expect(result.jobs).toEqual([{ id: "job-ready" }]);
    expect(result.skipped).toEqual([
      { codebaseId: "offline", reason: "OFFLINE" },
      { codebaseId: "mismatch", reason: "ORIGIN_MISMATCH" },
    ]);
  });
});
