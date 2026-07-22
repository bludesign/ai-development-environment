import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { PollingService } from "./polling.service";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
  getPrismaClient.mockResolvedValue({
    codebaseSettings: { findUnique: vi.fn(async () => null) },
    agent: { findMany: vi.fn(async () => []) },
    agentJob: { groupBy: vi.fn(async () => []) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  getPrismaClient.mockReset();
});

describe("PollingService", () => {
  test("tracks server runtime, completion details, failures, and disabled state", async () => {
    const service = new PollingService();
    service.register({
      id: "server:test",
      kind: "TEST",
      runtime: "SERVER",
      enabled: true,
      cadenceSeconds: 60,
      details: { mode: "POLLING" },
    });
    await expect(service.list()).resolves.toContainEqual(
      expect.objectContaining({ id: "server:test", status: "STALE" }),
    );

    await service.run(
      "server:test",
      async () => ({ count: 3 }),
      (result) => result,
    );
    await expect(service.list()).resolves.toContainEqual(
      expect.objectContaining({
        id: "server:test",
        status: "HEALTHY",
        details: { mode: "POLLING", count: 3 },
        lastStartedAt: "2026-07-22T12:00:00.000Z",
        lastCompletedAt: "2026-07-22T12:00:00.000Z",
        lastSucceededAt: "2026-07-22T12:00:00.000Z",
      }),
    );

    await expect(
      service.run("server:test", async () => {
        throw new Error("upstream unavailable");
      }),
    ).rejects.toThrow("upstream unavailable");
    await expect(service.list()).resolves.toContainEqual(
      expect.objectContaining({
        id: "server:test",
        status: "ERROR",
        lastError: "upstream unavailable",
      }),
    );

    service.configure("server:test", { enabled: false });
    await expect(service.list()).resolves.toContainEqual(
      expect.objectContaining({ id: "server:test", status: "DISABLED" }),
    );
  });

  test("derives heartbeat, durable job, scan, and fetch health per agent", async () => {
    getPrismaClient.mockResolvedValue({
      codebaseSettings: {
        findUnique: vi.fn(async () => ({
          refreshIntervalSeconds: 30,
          fetchIntervalSeconds: 300,
        })),
      },
      agent: {
        findMany: vi.fn(async () => [
          {
            id: "agent-1",
            name: "Build Mac",
            lastSeenAt: new Date("2026-07-22T11:59:55.000Z"),
            disconnectedAt: null,
            codebaseScanIntervalSeconds: 45,
            jobReconciliationIntervalSeconds: 20,
            gitFetchIntervalSeconds: 600,
            heartbeatIntervalSeconds: 10,
            codebases: [
              {
                lastCheckedAt: new Date("2026-07-22T11:59:45.000Z"),
                lastFetchedAt: new Date("2026-07-22T11:50:00.000Z"),
                lastFetchAttemptAt: new Date("2026-07-22T11:55:00.000Z"),
                lastFetchError: "authentication failed",
              },
            ],
          },
        ]),
      },
      agentJob: {
        groupBy: vi.fn(async () => [
          { agentId: "agent-1", status: "QUEUED", _count: { _all: 2 } },
          { agentId: "agent-1", status: "RUNNING", _count: { _all: 1 } },
        ]),
      },
    });
    const operations = await new PollingService().list();

    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agent-heartbeat:agent-1",
          kind: "AGENT_HEARTBEAT",
          status: "HEALTHY",
          cadenceSeconds: 10,
          details: expect.objectContaining({ connection: "ONLINE" }),
        }),
        expect.objectContaining({
          id: "agent-job-reconciliation:agent-1",
          kind: "AGENT_JOB_RECONCILIATION",
          cadenceSeconds: 20,
          details: expect.objectContaining({ pendingJobs: 3 }),
        }),
        expect.objectContaining({
          id: "agent-codebase-scan:agent-1",
          kind: "CODEBASE_SCAN",
          status: "HEALTHY",
          cadenceSeconds: 45,
        }),
        expect.objectContaining({
          id: "agent-git-fetch:agent-1",
          kind: "GIT_FETCH",
          status: "ERROR",
          cadenceSeconds: 600,
          details: expect.objectContaining({ repositories: 1, fetchErrors: 1 }),
        }),
      ]),
    );
  });
});
