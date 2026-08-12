import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import type {
  CcusageCollectionSnapshot,
  CcusageCompletionObserver,
  CcusageService,
} from "@/services/ccusage";
import type { DiskSpaceService } from "@/services/disk-space";
import type { PollingService } from "@/services/polling";

import { SystemStatusService } from "./system-status.service";

function dependencies() {
  let observer: CcusageCompletionObserver | undefined;
  const ccusage = {
    registerCompletionObserver: vi.fn((next: CcusageCompletionObserver) => {
      observer = next;
      return vi.fn();
    }),
  } as unknown as CcusageService;
  const diskSpace = {
    overview: vi.fn().mockResolvedValue({ settings: {}, agents: [] }),
  } as unknown as DiskSpaceService;
  return {
    ccusage,
    diskSpace,
    polling: {} as PollingService,
    observer: () => observer,
  };
}

describe("SystemStatusService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00"));
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  test("counts only work that is actively executing", async () => {
    const agentRunCount = vi.fn().mockResolvedValueOnce(2).mockResolvedValue(3);
    const buildCount = vi.fn().mockResolvedValue(4);
    const workflowCount = vi.fn().mockResolvedValue(5);
    const commandCount = vi.fn().mockResolvedValue(6);
    getPrismaClient.mockResolvedValue({
      sidebarUsageSummary: {
        findUnique: vi.fn().mockResolvedValue({
          period: "2026-07-25",
          totalCost: 12.5,
          collectedAt: new Date("2026-07-25T11:55:00"),
        }),
      },
      agentRun: { count: agentRunCount },
      build: { count: buildCount },
      workflowRun: { count: workflowCount },
      commandRun: { count: commandCount },
    });
    const { ccusage, diskSpace, polling } = dependencies();

    const result = await new SystemStatusService(
      ccusage,
      diskSpace,
      polling,
    ).status();

    expect(result.activity).toEqual({
      plans: 2,
      sessions: 3,
      builds: 4,
      workflows: 5,
      commands: 6,
    });
    expect(agentRunCount).toHaveBeenNthCalledWith(1, {
      where: {
        kind: "PLAN",
        archivedAt: null,
        status: "IN_PROGRESS",
        attempts: {
          some: {
            status: { in: ["STARTING", "RUNNING"] },
            supersededAt: null,
          },
        },
      },
    });
    expect(agentRunCount).toHaveBeenNthCalledWith(2, {
      where: {
        kind: "SESSION",
        archivedAt: null,
        status: "IN_PROGRESS",
        attempts: {
          some: {
            status: { in: ["STARTING", "RUNNING"] },
            supersededAt: null,
          },
        },
      },
    });
    expect(buildCount).toHaveBeenCalledWith({
      where: { status: { in: ["PREPARING", "RUNNING"] } },
    });
    expect(workflowCount).toHaveBeenCalledWith({
      where: { archivedAt: null, status: "RUNNING" },
    });
    expect(commandCount).toHaveBeenCalledWith({
      where: { archivedAt: null, status: "RUNNING" },
    });
  });

  test("stores historical usage after a collection completes without a fresh agent result", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    getPrismaClient.mockResolvedValue({
      sidebarUsageSummary: { upsert },
    });
    const { ccusage, diskSpace, polling, observer } = dependencies();
    new SystemStatusService(ccusage, diskSpace, polling);
    const completed = {
      progress: { successfulCount: 0 },
      aggregate: {
        days: [{ period: "2026-07-25", totalCost: 7.25 }],
      },
    } as CcusageCollectionSnapshot;

    await observer()?.(completed);

    expect(upsert).toHaveBeenCalledWith({
      where: { id: "default" },
      create: {
        id: "default",
        period: "2026-07-25",
        totalCost: 7.25,
        collectedAt: new Date("2026-07-25T12:00:00"),
      },
      update: {
        period: "2026-07-25",
        totalCost: 7.25,
        collectedAt: new Date("2026-07-25T12:00:00"),
      },
    });
  });

  test("removes a completed background collection after it populates usage", async () => {
    const collectionDelete = vi.fn().mockResolvedValue({ count: 1 });
    const jobDelete = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      ccusageCollection: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: collectionDelete,
      },
      agentJob: { deleteMany: jobDelete },
    });
    const collect = vi.fn().mockResolvedValue({
      progress: { successfulCount: 1 },
    });
    const polling = {
      register: vi.fn(),
      schedule: vi.fn(),
      run: vi.fn(async (_id: string, work: () => Promise<unknown>) => {
        await work();
      }),
    } as unknown as PollingService;
    const { ccusage, diskSpace } = dependencies();
    (ccusage as unknown as { collect: unknown }).collect = collect;
    const service = new SystemStatusService(ccusage, diskSpace, polling);

    service.startRuntime();

    await vi.waitFor(() => expect(collectionDelete).toHaveBeenCalledOnce());
    const collectionId = collect.mock.calls[0]?.[0];
    expect(collectionId).toMatch(/^sidebar-usage:/);
    expect(jobDelete).toHaveBeenCalledWith({
      where: { ccusageCollectionId: collectionId },
    });
    expect(collectionDelete).toHaveBeenCalledWith({
      where: { id: collectionId },
    });
    expect(collect.mock.invocationCallOrder[0]).toBeLessThan(
      jobDelete.mock.invocationCallOrder[0] ?? Infinity,
    );
    service.stopRuntime();
  });

  test("polls without collecting when collection is disabled", async () => {
    vi.stubEnv("SIDEBAR_USAGE_COLLECTION_DISABLED", "true");
    getPrismaClient.mockResolvedValue({
      ccusageCollection: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const collect = vi.fn();
    const polling = {
      register: vi.fn(),
      schedule: vi.fn(),
      run: vi.fn(async (_id: string, work: () => Promise<unknown>) => {
        await work();
      }),
    } as unknown as PollingService;
    const { ccusage, diskSpace } = dependencies();
    (ccusage as unknown as { collect: unknown }).collect = collect;
    const service = new SystemStatusService(ccusage, diskSpace, polling);

    service.startRuntime();

    // The operation still reports on its own cadence, so the Polling page
    // describes it the way a real deployment sees it.
    expect(polling.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sidebar-usage", enabled: true }),
    );
    await vi.waitFor(() => expect(polling.run).toHaveBeenCalledOnce());
    expect(collect).not.toHaveBeenCalled();
    service.stopRuntime();
    vi.unstubAllEnvs();
  });

  test("starts polling when interrupted-collection cleanup fails", async () => {
    const cleanupError = new Error("CcusageCollection table does not exist");
    getPrismaClient.mockResolvedValue({
      ccusageCollection: {
        findMany: vi.fn().mockRejectedValue(cleanupError),
      },
    });
    const polling = {
      register: vi.fn(),
      schedule: vi.fn(),
      run: vi.fn().mockResolvedValue(undefined),
    } as unknown as PollingService;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { ccusage, diskSpace } = dependencies();
    const service = new SystemStatusService(ccusage, diskSpace, polling);

    service.startRuntime();

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "Sidebar usage cleanup failed:",
        cleanupError.message,
      );
      expect(polling.run).toHaveBeenCalledOnce();
    });
    service.stopRuntime();
  });
});
