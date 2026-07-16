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

describe("CcusageService", () => {
  beforeEach(() => vi.clearAllMocks());

  test("creates an empty collection once and rejoins it by request ID", async () => {
    let collection: Record<string, unknown> | null = null;
    const prisma = {
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
    };
    getPrismaClient.mockResolvedValue(prisma);
    const agentControl = {
      listAgents: vi.fn().mockResolvedValue([]),
      createJob: vi.fn(),
      timeoutCollectionJobs: vi.fn(),
    } as unknown as AgentControlService;
    const now = () => new Date("2026-07-16T12:00:00Z");
    const service = new CcusageService(agentControl, now);

    const first = await service.collect("request-1");
    const second = await service.collect("request-1");

    expect(first.status).toBe("COMPLETED");
    expect(first.aggregate.days).toEqual([]);
    expect(second.id).toBe(first.id);
    expect(prisma.ccusageCollection.create).toHaveBeenCalledTimes(1);
    expect(agentControl.createJob).not.toHaveBeenCalled();
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
    const prisma = {
      ccusageCollection: {
        findUnique: vi.fn().mockResolvedValue(persisted),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
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
    const prisma = {
      ccusageCollection: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(running)
          .mockResolvedValueOnce(timedOut),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
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
});
