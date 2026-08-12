import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import type { AgentControlService } from "@/services/agent-control";

import { CcusageService } from "./ccusage.service";

function agent(id: string) {
  return {
    id,
    name: `Agent ${id}`,
    hostname: `${id}.local`,
    version: "0.1.0",
    osVersion: "macOS",
    architecture: "arm64",
    capabilitiesJson: '["ccusage.report"]',
    secretHash: "hash",
    ipAddress: null,
    lastSeenAt: new Date("2026-07-16T12:00:00Z"),
    disconnectedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const report = {
  daily: [
    {
      agent: "all",
      period: "2026-07-16",
      inputTokens: 3_000_000_000,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
      totalTokens: 3_000_000_090,
      totalCost: 1.25,
      metadata: { agents: ["codex"] },
      modelsUsed: ["gpt-5"],
      modelBreakdowns: [
        {
          modelName: "gpt-5",
          inputTokens: 3_000_000_000,
          outputTokens: 20,
          cacheCreationTokens: 30,
          cacheReadTokens: 40,
          cost: 1.25,
        },
      ],
    },
  ],
  totals: {
    inputTokens: 3_000_000_000,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    totalTokens: 3_000_000_090,
    totalCost: 1.25,
  },
};

function resultJson() {
  return JSON.stringify({
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    report,
  });
}

function withHistory<T extends Record<string, unknown>>(prisma: T) {
  const enriched = Object.assign(prisma, {
    ccusageHistory: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    ccusageHistoryState: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    sidebarUsageSummary: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(),
  });
  enriched.$transaction.mockImplementation(
    (operation: (transaction: typeof enriched) => unknown) =>
      operation(enriched),
  );
  return enriched;
}

describe("CcusageService", () => {
  beforeEach(() => vi.clearAllMocks());

  test("creates an empty collection once and rejoins it by request ID", async () => {
    let collection: Record<string, unknown> | null = null;
    const prisma = withHistory({
      ccusageCollection: {
        findUnique: vi.fn(async ({ include }: { include?: unknown }) => {
          if (!collection) return null;
          return include
            ? { ...collection, agents: [], jobs: [] }
            : {
                id: collection.id,
                deadlineAt: collection.deadlineAt,
                finishedAt: collection.finishedAt,
              };
        }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          collection = {
            id: data.id,
            deadlineAt: data.deadlineAt,
            finishedAt: null,
            createdAt: new Date("2026-07-16T12:00:00Z"),
            updatedAt: new Date("2026-07-16T12:00:00Z"),
          };
          return { id: data.id };
        }),
        updateMany: vi.fn(async ({ data }: { data: { finishedAt: Date } }) => {
          if (collection) collection.finishedAt = data.finishedAt;
          return { count: 1 };
        }),
      },
      ccusageCollectionAgent: { findMany: vi.fn().mockResolvedValue([]) },
      agentJob: { findMany: vi.fn().mockResolvedValue([]) },
    });
    getPrismaClient.mockResolvedValue(prisma);
    const agentControl = {
      listAgents: vi.fn().mockResolvedValue([]),
      createJob: vi.fn(),
      timeoutCollectionJobs: vi.fn(),
    } as unknown as AgentControlService;
    const now = () => new Date("2026-07-16T12:00:00Z");
    const service = new CcusageService(agentControl, now);
    const observer = vi.fn();
    service.registerCompletionObserver(observer);

    const first = await service.collect("request-1");
    const second = await service.collect("request-1");

    expect(first.status).toBe("COMPLETED");
    expect(first.aggregate.days).toEqual([]);
    expect(second.id).toBe(first.id);
    expect(prisma.ccusageCollection.create).toHaveBeenCalledTimes(1);
    expect(agentControl.createJob).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenLastCalledWith(second);
  });

  test("parses successful jobs, excludes failures, and returns a typed partial aggregate", async () => {
    const alpha = agent("alpha");
    const beta = agent("beta");
    const persisted = {
      id: "collection-1",
      deadlineAt: new Date("2026-07-16T12:02:30Z"),
      finishedAt: null,
      createdAt: new Date("2026-07-16T12:00:00Z"),
      updatedAt: new Date("2026-07-16T12:00:00Z"),
      agents: [
        {
          agentId: alpha.id,
          initialStatus: "QUEUING",
          error: null,
          agent: alpha,
        },
        {
          agentId: beta.id,
          initialStatus: "QUEUING",
          error: null,
          agent: beta,
        },
      ],
      jobs: [
        {
          id: "job-alpha",
          agentId: alpha.id,
          status: "SUCCEEDED",
          resultJson: resultJson(),
          error: null,
        },
        {
          id: "job-beta",
          agentId: beta.id,
          status: "FAILED",
          resultJson: null,
          error: "missing ccusage",
        },
      ],
    };
    const prisma = withHistory({
      ccusageCollection: {
        findUnique: vi.fn().mockResolvedValue(persisted),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CcusageService(
      {} as AgentControlService,
      () => new Date("2026-07-16T12:01:00Z"),
    );

    const snapshot = await service.getCollection("collection-1");

    expect(snapshot?.status).toBe("COMPLETED");
    expect(snapshot?.progress).toMatchObject({
      eligibleCount: 2,
      finishedCount: 2,
      successfulCount: 1,
    });
    expect(snapshot?.progress.agents[1]).toMatchObject({
      status: "FAILED",
      error: "missing ccusage",
    });
    expect(snapshot?.aggregate.totals.inputTokens).toBe(3_000_000_000);
    expect(snapshot?.aggregate.days[0]?.models[0]?.agents[0]?.agentId).toBe(
      "alpha",
    );
  });

  test("orders persisted reports by job start instead of completion", async () => {
    const alpha = agent("alpha");
    const startedAt = new Date("2026-07-16T12:00:00Z");
    const persisted = {
      id: "collection-ordered",
      deadlineAt: new Date("2026-07-16T12:03:00Z"),
      finishedAt: null,
      createdAt: new Date("2026-07-16T11:59:30Z"),
      updatedAt: new Date("2026-07-16T12:02:00Z"),
      agents: [
        {
          agentId: alpha.id,
          initialStatus: "QUEUING",
          error: null,
          agent: alpha,
        },
      ],
      jobs: [
        {
          id: "job-alpha",
          agentId: alpha.id,
          status: "SUCCEEDED",
          resultJson: resultJson(),
          error: null,
          createdAt: new Date("2026-07-16T11:59:45Z"),
          startedAt,
          finishedAt: new Date("2026-07-16T12:02:00Z"),
          updatedAt: new Date("2026-07-16T12:02:00Z"),
        },
      ],
    };
    const prisma = withHistory({
      ccusageCollection: {
        findUnique: vi.fn().mockResolvedValue(persisted),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CcusageService(
      {} as AgentControlService,
      () => new Date("2026-07-16T12:02:01Z"),
    );

    await service.getCollection(persisted.id);

    expect(prisma.ccusageHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ lastObservedAt: startedAt }),
      }),
    );
  });

  test("combines stored agents with live results while a collection is partial", async () => {
    const alpha = agent("alpha");
    const beta = agent("beta");
    const persisted = {
      id: "collection-partial",
      deadlineAt: new Date("2026-07-16T12:02:30Z"),
      finishedAt: null,
      createdAt: new Date("2026-07-16T12:00:00Z"),
      updatedAt: new Date("2026-07-16T12:00:00Z"),
      agents: [
        {
          agentId: alpha.id,
          initialStatus: "QUEUING",
          error: null,
          agent: alpha,
        },
        {
          agentId: beta.id,
          initialStatus: "QUEUING",
          error: null,
          agent: beta,
        },
      ],
      jobs: [
        {
          id: "job-alpha",
          agentId: alpha.id,
          status: "SUCCEEDED",
          resultJson: resultJson(),
          error: null,
          finishedAt: new Date("2026-07-16T12:00:30Z"),
        },
        {
          id: "job-beta",
          agentId: beta.id,
          status: "RUNNING",
          resultJson: null,
          error: null,
        },
      ],
    };
    const prisma = withHistory({
      ccusageCollection: {
        findUnique: vi.fn().mockResolvedValue(persisted),
      },
    });
    prisma.ccusageHistory.findMany.mockResolvedValue([
      {
        agentId: beta.id,
        agentName: beta.name,
        hostname: beta.hostname,
        archivedReportJson: JSON.stringify({
          daily: [],
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 0,
            totalCost: 0,
          },
        }),
        lastLiveReportJson: JSON.stringify(report),
      },
    ]);
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CcusageService(
      {} as AgentControlService,
      () => new Date("2026-07-16T12:01:00Z"),
    );

    const snapshot = await service.getCollection(persisted.id);

    expect(snapshot?.status).toBe("COLLECTING");
    expect(snapshot?.hasStoredHistory).toBe(true);
    expect(snapshot?.liveAggregate.totals.inputTokens).toBe(3_000_000_000);
    expect(snapshot?.aggregate.totals.inputTokens).toBe(6_000_000_000);
    expect(
      snapshot?.aggregate.days[0]?.models[0]?.agents.map(
        ({ agentId }) => agentId,
      ),
    ).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  test("times out active jobs when a persisted deadline has elapsed", async () => {
    const running = {
      id: "collection-1",
      deadlineAt: new Date("2026-07-16T12:00:00Z"),
      finishedAt: null,
      createdAt: new Date("2026-07-16T11:57:30Z"),
      updatedAt: new Date("2026-07-16T11:57:30Z"),
      agents: [
        {
          agentId: "alpha",
          initialStatus: "QUEUING",
          error: null,
          agent: agent("alpha"),
        },
      ],
      jobs: [
        {
          id: "job-alpha",
          agentId: "alpha",
          status: "RUNNING",
          resultJson: null,
          error: null,
        },
      ],
    };
    const timedOut = {
      ...running,
      jobs: [{ ...running.jobs[0], status: "TIMED_OUT" }],
    };
    const prisma = withHistory({
      ccusageCollection: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(running)
          .mockResolvedValueOnce(timedOut),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    getPrismaClient.mockResolvedValue(prisma);
    const agentControl = {
      timeoutCollectionJobs: vi.fn().mockResolvedValue([]),
    } as unknown as AgentControlService;
    const service = new CcusageService(
      agentControl,
      () => new Date("2026-07-16T12:00:01Z"),
    );

    const snapshot = await service.getCollection("collection-1");

    expect(agentControl.timeoutCollectionJobs).toHaveBeenCalledWith(
      "collection-1",
    );
    expect(snapshot?.status).toBe("COMPLETED");
    expect(snapshot?.progress.agents[0]?.status).toBe("TIMED_OUT");
  });

  test("finalizes expired restored members that never received a job", async () => {
    let initialStatus = "QUEUING";
    let finishedAt: Date | null = null;
    const deadlineAt = new Date("2026-07-16T12:00:00Z");
    const createdAt = new Date("2026-07-16T11:57:30Z");
    const prisma = withHistory({
      ccusageCollection: {
        findMany: vi.fn().mockResolvedValue([{ id: "collection-1" }]),
        findUnique: vi.fn(async ({ include }: { include?: unknown }) =>
          include
            ? {
                id: "collection-1",
                deadlineAt,
                finishedAt,
                createdAt,
                updatedAt: createdAt,
                agents: [
                  {
                    agentId: "alpha",
                    initialStatus,
                    error: null,
                    agent: agent("alpha"),
                  },
                ],
                jobs: [],
              }
            : { id: "collection-1", deadlineAt, finishedAt },
        ),
        updateMany: vi.fn(async ({ data }: { data: { finishedAt: Date } }) => {
          finishedAt = data.finishedAt;
          return { count: 1 };
        }),
      },
      ccusageCollectionAgent: {
        updateMany: vi.fn(
          async ({ data }: { data: { initialStatus: string } }) => {
            initialStatus = data.initialStatus;
            return { count: 1 };
          },
        ),
      },
    });
    getPrismaClient.mockResolvedValue(prisma);
    const agentControl = {
      timeoutCollectionJobs: vi.fn().mockResolvedValue([]),
    } as unknown as AgentControlService;
    const service = new CcusageService(
      agentControl,
      () => new Date("2026-07-16T12:00:01Z"),
    );

    await service.initialize();
    const snapshot = await service.getCollection("collection-1");

    expect(prisma.ccusageCollectionAgent.updateMany).toHaveBeenCalledWith({
      where: {
        collectionId: "collection-1",
        agentId: { in: ["alpha"] },
        initialStatus: "QUEUING",
      },
      data: { initialStatus: "TIMED_OUT" },
    });
    expect(snapshot?.status).toBe("COMPLETED");
    expect(snapshot?.progress.agents[0]).toMatchObject({
      jobId: null,
      status: "TIMED_OUT",
    });
  });

  test("clears every stored agent history and advances the watermark", async () => {
    const prisma = withHistory({});
    prisma.ccusageHistory.deleteMany.mockResolvedValue({ count: 3 });
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CcusageService(
      {} as AgentControlService,
      () => new Date("2026-07-16T12:00:00Z"),
    );

    await expect(service.clearHistory()).resolves.toBe(3);
    expect(prisma.sidebarUsageSummary.deleteMany).toHaveBeenCalledOnce();
    expect(prisma.ccusageHistoryState.upsert).toHaveBeenCalledWith({
      where: { id: "default" },
      create: {
        id: "default",
        clearedAt: new Date("2026-07-16T12:00:00Z"),
      },
      update: { clearedAt: new Date("2026-07-16T12:00:00Z") },
    });
  });

  test("does not repersist a successful report observed before the clear", async () => {
    const alpha = agent("alpha");
    const persisted = {
      id: "collection-before-clear",
      deadlineAt: new Date("2026-07-16T12:02:30Z"),
      finishedAt: new Date("2026-07-16T11:59:00Z"),
      createdAt: new Date("2026-07-16T11:58:00Z"),
      updatedAt: new Date("2026-07-16T11:59:00Z"),
      agents: [
        {
          agentId: alpha.id,
          initialStatus: "QUEUING",
          error: null,
          agent: alpha,
        },
      ],
      jobs: [
        {
          id: "job-alpha",
          agentId: alpha.id,
          status: "SUCCEEDED",
          resultJson: resultJson(),
          error: null,
          createdAt: new Date("2026-07-16T11:58:00Z"),
          finishedAt: new Date("2026-07-16T11:59:00Z"),
          updatedAt: new Date("2026-07-16T11:59:00Z"),
        },
      ],
    };
    const prisma = withHistory({
      ccusageCollection: {
        findUnique: vi.fn().mockResolvedValue(persisted),
      },
    });
    prisma.ccusageHistoryState.findUnique.mockResolvedValue({
      clearedAt: new Date("2026-07-16T12:00:00Z"),
    });
    getPrismaClient.mockResolvedValue(prisma);
    const service = new CcusageService({} as AgentControlService);

    const snapshot = await service.getCollection(persisted.id);

    expect(prisma.ccusageHistory.upsert).not.toHaveBeenCalled();
    expect(snapshot?.hasStoredHistory).toBe(false);
    expect(snapshot?.aggregate.totals.inputTokens).toBe(3_000_000_000);
  });
});
