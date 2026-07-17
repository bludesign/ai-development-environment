import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_INSPECT_JOB_KIND,
  type CodebaseSnapshot,
} from "@ai-development-environment/agent-contract/codebases";
import {
  CODEBASE_CHANGED_TOPIC,
  agentEventBus,
  type AgentControlService,
} from "@/services/agent-control";

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
      lastCheckedAt: new Date(5),
      lastFetchedAt: new Date(5),
      repository: { canonicalOrigin: "example.com/old/repo" },
    };
    const prisma = {
      codebase: {
        findUnique: vi.fn().mockResolvedValue(current),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CodebasesService(control());

    await service.report("agent-1", [{ codebaseId: "codebase-1", snapshot }]);

    expect(prisma.codebase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          availability: "ORIGIN_MISMATCH",
          lastCheckedAt: new Date(10),
          statusError: "Origin changed to example.com/new/repo",
        }),
      }),
    );
    expect(prisma.codebase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ lastFetchedAt: null }, { lastFetchedAt: { lt: new Date(1) } }],
        }),
        data: { lastFetchedAt: new Date(1) },
      }),
    );
  });

  test("requests an immediate reconcile after confirming a codebase", async () => {
    const repository = {
      id: "repository-1",
      canonicalOrigin: snapshot.canonicalOrigin,
    };
    const confirmed = {
      id: "codebase-1",
      agentId: "agent-1",
      repositoryId: repository.id,
      repository,
      agent: {},
      jobs: [],
    };
    const transaction = {
      codebaseRepository: {
        findUnique: vi.fn().mockResolvedValue(repository),
      },
      codebase: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(confirmed),
      },
    };
    const prisma = {
      agentJob: {
        findUnique: vi.fn().mockResolvedValue({
          id: "inspection-1",
          agentId: "agent-1",
          kind: CODEBASE_INSPECT_JOB_KIND,
          status: "SUCCEEDED",
          resultJson: JSON.stringify({ snapshot }),
          error: null,
          finishedAt: new Date(),
        }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    getPrismaClient.mockResolvedValue(prisma);
    const agentControl = control();
    const requestCodebaseReconcile = vi.fn().mockReturnValue(1);
    Object.assign(agentControl, { requestCodebaseReconcile });
    const service = new CodebasesService(agentControl);

    await expect(
      service.confirm({ inspectionJobId: "inspection-1" }),
    ).resolves.toBe(confirmed);

    expect(requestCodebaseReconcile).toHaveBeenCalledWith(["agent-1"]);
  });

  test("atomically ignores snapshots older than the stored status", async () => {
    const current = {
      id: "codebase-1",
      agentId: "agent-1",
      repositoryId: "repository-1",
      observedOrigin: "git@example.com:new/repo.git",
      lastCheckedAt: new Date(20),
      lastFetchedAt: new Date(20),
      repository: { canonicalOrigin: "example.com/new/repo" },
    };
    const prisma = {
      codebase: {
        findUnique: vi.fn().mockResolvedValue(current),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const publish = vi.spyOn(agentEventBus, "publish");
    const service = new CodebasesService(control());

    await service.report("agent-1", [{ codebaseId: "codebase-1", snapshot }]);

    expect(prisma.codebase.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.codebase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { lastCheckedAt: null },
            { lastCheckedAt: { lt: new Date(10) } },
          ],
        }),
      }),
    );
    expect(publish).not.toHaveBeenCalledWith(
      CODEBASE_CHANGED_TOPIC,
      expect.anything(),
    );
    publish.mockRestore();
  });

  test("publishes one overview change for a status report batch", async () => {
    const current = (id: string) => ({
      id,
      agentId: "agent-1",
      repositoryId: `repository-${id}`,
      observedOrigin: snapshot.observedOrigin,
      lastCheckedAt: null,
      lastFetchedAt: null,
      repository: { canonicalOrigin: snapshot.canonicalOrigin },
    });
    const prisma = {
      codebase: {
        findUnique: vi.fn(({ where }) => Promise.resolve(current(where.id))),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const publish = vi.spyOn(agentEventBus, "publish");
    const service = new CodebasesService(control());

    await service.report("agent-1", [
      { codebaseId: "codebase-1", snapshot },
      { codebaseId: "codebase-2", snapshot },
    ]);

    expect(
      publish.mock.calls.filter(([topic]) => topic === CODEBASE_CHANGED_TOPIC),
    ).toEqual([
      [
        CODEBASE_CHANGED_TOPIC,
        {
          codebaseOverviewChanged: {
            codebaseId: null,
            repositoryId: null,
          },
        },
      ],
    ]);
    publish.mockRestore();
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
            defaultBranch: "main",
            availability: "AVAILABLE",
            agent: capable,
            repository: {
              canonicalOrigin: "example.com/ready",
              keepBaseBranchUpToDate: true,
            },
            jobs: [],
          },
          {
            id: "offline",
            agentId: "agent-2",
            folder: "/offline",
            availability: "AVAILABLE",
            agent: { ...capable, lastSeenAt: new Date(0) },
            repository: { canonicalOrigin: "example.com/offline" },
            jobs: [],
          },
          {
            id: "mismatch",
            agentId: "agent-1",
            folder: "/mismatch",
            availability: "ORIGIN_MISMATCH",
            agent: capable,
            repository: { canonicalOrigin: "example.com/mismatch" },
            jobs: [],
          },
          {
            id: "active",
            agentId: "agent-1",
            folder: "/active",
            availability: "AVAILABLE",
            agent: capable,
            repository: { canonicalOrigin: "example.com/active" },
            jobs: [{ id: "job-active" }],
          },
        ]),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const agentControl = control();
    const service = new CodebasesService(agentControl);

    const result = await service.runOperation(
      CODEBASE_FETCH_JOB_KIND,
      ["ready", "offline", "mismatch", "active"],
      "request-1",
    );

    expect(agentControl.createJob).toHaveBeenCalledTimes(1);
    expect(agentControl.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          codebaseId: "ready",
          folder: "/ready",
          expectedOrigin: "example.com/ready",
          baseBranch: "main",
          keepBaseBranchUpToDate: true,
        },
      }),
    );
    expect(result.jobs).toEqual([{ id: "job-ready" }]);
    expect(result.skipped).toEqual([
      { codebaseId: "offline", reason: "OFFLINE" },
      { codebaseId: "mismatch", reason: "ORIGIN_MISMATCH" },
      { codebaseId: "active", reason: "ACTIVE_OPERATION" },
    ]);
  });

  test("skips a codebase when another request wins the scheduling race", async () => {
    const capable = {
      lastSeenAt: new Date(),
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
            jobs: [],
          },
        ]),
      },
      agentJob: {
        findFirst: vi.fn().mockResolvedValue({ id: "concurrent-job" }),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const agentControl = control();
    vi.mocked(agentControl.createJob).mockRejectedValue(
      new Error("unique constraint failed"),
    );
    const service = new CodebasesService(agentControl);

    await expect(
      service.runOperation(CODEBASE_FETCH_JOB_KIND, ["ready"], "request-2"),
    ).resolves.toEqual({
      jobs: [],
      skipped: [{ codebaseId: "ready", reason: "ACTIVE_OPERATION" }],
    });
  });

  test("removes repository metadata with its final registered codebase", async () => {
    const transaction = {
      codebase: {
        findUnique: vi.fn().mockResolvedValue({
          id: "codebase-1",
          repositoryId: "repository-1",
        }),
        delete: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
      },
      codebaseRepository: {
        delete: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CodebasesService(control());

    await expect(service.removeCodebase("codebase-1")).resolves.toEqual({
      id: "codebase-1",
      repositoryId: "repository-1",
      repositoryRemoved: true,
    });

    expect(transaction.codebase.delete).toHaveBeenCalledWith({
      where: { id: "codebase-1" },
    });
    expect(transaction.codebaseRepository.delete).toHaveBeenCalledWith({
      where: { id: "repository-1" },
    });
  });

  test("keeps shared repository metadata when another codebase remains", async () => {
    const transaction = {
      codebase: {
        findUnique: vi.fn().mockResolvedValue({
          id: "codebase-1",
          repositoryId: "repository-1",
        }),
        delete: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(1),
      },
      codebaseRepository: {
        delete: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CodebasesService(control());

    await expect(service.removeCodebase("codebase-1")).resolves.toEqual({
      id: "codebase-1",
      repositoryId: "repository-1",
      repositoryRemoved: false,
    });

    expect(transaction.codebaseRepository.delete).not.toHaveBeenCalled();
  });

  test("returns the refresh interval with only the requesting agent's codebases", async () => {
    const updatedAt = new Date(0);
    const prisma = {
      codebaseSettings: {
        findUnique: vi.fn().mockResolvedValue({
          id: "default",
          refreshIntervalSeconds: 120,
          fetchIntervalSeconds: 300,
          updatedAt,
        }),
      },
      codebase: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "codebase-1",
            folder: "/repo",
            repository: {
              canonicalOrigin: "example.com/repo",
              keepBaseBranchUpToDate: true,
            },
          },
        ]),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CodebasesService(control());

    await expect(service.agentConfiguration("agent-1")).resolves.toEqual({
      refreshIntervalSeconds: 120,
      fetchIntervalSeconds: 300,
      codebases: [
        {
          id: "codebase-1",
          folder: "/repo",
          repository: {
            canonicalOrigin: "example.com/repo",
            keepBaseBranchUpToDate: true,
          },
        },
      ],
    });
    expect(prisma.codebase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agentId: "agent-1" } }),
    );
  });

  test("updates the repository-wide base branch setting", async () => {
    const repository = {
      id: "repository-1",
      name: "Codex",
      description: "Developer tooling",
      jiraBranchRegex: null,
      keepBaseBranchUpToDate: false,
    };
    const prisma = {
      codebaseRepository: {
        update: vi.fn().mockResolvedValue(repository),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CodebasesService(control());

    await expect(
      service.updateRepository(
        "repository-1",
        " Codex ",
        " Developer tooling ",
        null,
        false,
      ),
    ).resolves.toBe(repository);
    expect(prisma.codebaseRepository.update).toHaveBeenCalledWith({
      where: { id: "repository-1" },
      data: {
        name: "Codex",
        description: "Developer tooling",
        jiraBranchRegex: null,
        keepBaseBranchUpToDate: false,
      },
    });
  });

  test("validates and persists the agent refresh interval", async () => {
    const updatedAt = new Date(0);
    const prisma = {
      codebaseSettings: {
        upsert: vi.fn().mockResolvedValue({
          id: "default",
          refreshIntervalSeconds: 120,
          updatedAt,
        }),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CodebasesService(control());

    await expect(service.updateSettings(120)).resolves.toEqual({
      id: "default",
      refreshIntervalSeconds: 120,
      updatedAt,
    });
    expect(prisma.codebaseSettings.upsert).toHaveBeenCalledWith({
      where: { id: "default" },
      create: { id: "default", refreshIntervalSeconds: 120 },
      update: { refreshIntervalSeconds: 120 },
    });
    await expect(service.updateSettings(9)).rejects.toThrow(
      "Refresh interval must be an integer from 10 to 3600 seconds",
    );
  });
});
