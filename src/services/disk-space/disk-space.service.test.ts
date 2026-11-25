import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  BUILD_DATA_DELETE_JOB_KIND,
  GRADLE_WORKTREE_CLEANUP_CAPABILITY,
} from "@ai-development-environment/agent-contract/build-data";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
vi.mock("./executing-work", () => ({
  executingResourcesByWorktree: vi.fn(
    async (ids: string[]) => new Map(ids.map((id) => [id, []])),
  ),
}));

import { AgentControlService } from "@/services/agent-control";
import { executingResourcesByWorktree } from "./executing-work";

import {
  DiskSpaceService,
  NO_MONITORED_VOLUME_WARNING,
} from "./disk-space.service";

function prismaForState(state: {
  enabled: boolean;
  lastReportedAt: Date | null;
  lastError: string | null;
  volumesJson: string;
}) {
  return {
    diskSpaceSettings: {
      upsert: vi.fn().mockResolvedValue({
        normalThresholdGiB: 40,
        pressureThresholdGiB: 10,
      }),
    },
    agentDiskSpaceState: {
      findUnique: vi.fn().mockResolvedValue(state),
    },
  };
}

function service() {
  return new DiskSpaceService({
    registerCompletionObserver: vi.fn(),
  } as unknown as AgentControlService);
}

describe("DiskSpaceService admission control", () => {
  beforeEach(() => vi.clearAllMocks());

  test("blocks new work at or below the critical threshold", async () => {
    getPrismaClient.mockResolvedValue(
      prismaForState({
        enabled: true,
        lastReportedAt: new Date(),
        lastError: null,
        volumesJson: JSON.stringify([
          {
            id: "device-1",
            totalBytes: 100 * 1024 ** 3,
            freeBytes: 10 * 1024 ** 3,
            roles: ["MAIN", "DERIVED_DATA"],
            paths: ["/"],
          },
        ]),
      }),
    );

    await expect(service().assertAgentCanStart("agent-1")).rejects.toThrow(
      "paused",
    );
  });

  test("ignores volumes that do not hold Derived Data", async () => {
    getPrismaClient.mockResolvedValue(
      prismaForState({
        enabled: true,
        lastReportedAt: new Date(),
        lastError: null,
        volumesJson: JSON.stringify([
          {
            id: "device-1",
            totalBytes: 100 * 1024 ** 3,
            freeBytes: 1 * 1024 ** 3,
            roles: ["MAIN", "BASE_REPO"],
            paths: ["/"],
          },
          {
            id: "device-2",
            totalBytes: 100 * 1024 ** 3,
            freeBytes: 80 * 1024 ** 3,
            roles: ["DERIVED_DATA"],
            paths: ["/Volumes/Data/DerivedData"],
          },
        ]),
      }),
    );

    await expect(
      service().assertAgentCanStart("agent-1"),
    ).resolves.toBeUndefined();
  });

  test.each([
    {
      label: "stale",
      state: {
        enabled: true,
        lastReportedAt: new Date(Date.now() - 121_000),
        lastError: null,
      },
    },
    {
      label: "disabled",
      state: { enabled: false, lastReportedAt: new Date(), lastError: null },
    },
    {
      label: "errored",
      state: {
        enabled: true,
        lastReportedAt: new Date(),
        lastError: "unavailable",
      },
    },
  ])("fails open for $label telemetry", async ({ state }) => {
    getPrismaClient.mockResolvedValue(
      prismaForState({
        ...state,
        volumesJson: JSON.stringify([
          {
            id: "device-1",
            totalBytes: 100,
            freeBytes: 0,
            roles: ["MAIN", "DERIVED_DATA"],
            paths: ["/"],
          },
        ]),
      }),
    );

    await expect(
      service().assertAgentCanStart("agent-1"),
    ).resolves.toBeUndefined();
  });

  test("requires positive ordered global thresholds", async () => {
    await expect(
      service().updateSettings({
        normalThresholdGiB: 10,
        pressureThresholdGiB: 10,
      }),
    ).rejects.toThrow("lower than");
    await expect(
      service().updateSettings({
        normalThresholdGiB: Number.NaN,
        pressureThresholdGiB: 1,
      }),
    ).rejects.toThrow("positive finite");
  });

  test("does not expire a cleanup lease after it is linked to a job", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    getPrismaClient.mockResolvedValue({
      derivedDataCleanupLease: {
        deleteMany,
        findUnique: vi.fn().mockResolvedValue({
          worktreeId: "worktree-1",
          jobId: "delete-1",
          expiresAt: new Date(0),
        }),
      },
      worktree: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      service().assertWorktreeCanStart("worktree-1"),
    ).rejects.toThrow("cleanup is in progress");
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        worktreeId: "worktree-1",
        jobId: null,
        expiresAt: { lte: expect.any(Date) },
      },
    });
  });
});

describe("DiskSpaceService overview", () => {
  beforeEach(() => vi.clearAllMocks());

  function prismaForOverview(volumes: unknown[]) {
    return {
      diskSpaceSettings: {
        upsert: vi.fn().mockResolvedValue({
          normalThresholdGiB: 40,
          pressureThresholdGiB: 10,
        }),
      },
      derivedDataCleanupLease: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "agent-1",
            name: "Builder",
            diskSpaceState: {
              enabled: true,
              manualPressureMode: false,
              automaticPressureMode: false,
              lastReportedAt: new Date(),
              lastError: null,
              warningsJson: "[]",
              volumesJson: JSON.stringify(volumes),
            },
          },
        ]),
      },
    };
  }

  test("only the Derived Data volume escalates agent status", async () => {
    const gib = 1024 ** 3;
    getPrismaClient.mockResolvedValue(
      prismaForOverview([
        {
          id: "root-device",
          capacityId: "apfs:disk1",
          totalBytes: 100 * gib,
          freeBytes: 2 * gib,
          roles: ["MAIN", "BASE_REPO"],
          paths: ["/"],
        },
        {
          id: "data-device",
          capacityId: "apfs:disk3",
          totalBytes: 100 * gib,
          freeBytes: 80 * gib,
          roles: ["DERIVED_DATA"],
          paths: ["/Volumes/Data/DerivedData"],
        },
      ]),
    );

    const view = (await service().overview()).agents[0]!;

    expect(view.status).toBe("IDLE");
    expect(view.warnings).toEqual([]);
    expect(
      view.volumes.map((volume) => [
        volume.id,
        volume.monitored,
        volume.status,
      ]),
    ).toEqual([
      ["root-device", false, "IDLE"],
      ["data-device", true, "IDLE"],
    ]);
  });

  test("warns when nothing reported holds Derived Data", async () => {
    const gib = 1024 ** 3;
    getPrismaClient.mockResolvedValue(
      prismaForOverview([
        {
          id: "root-device",
          capacityId: "apfs:disk1",
          totalBytes: 100 * gib,
          freeBytes: 2 * gib,
          roles: ["MAIN"],
          paths: ["/"],
        },
      ]),
    );

    const view = (await service().overview()).agents[0]!;

    expect(view.status).toBe("IDLE");
    expect(view.warnings).toEqual([NO_MONITORED_VOLUME_WARNING]);
  });
});

describe("DiskSpaceService monitor notifications", () => {
  beforeEach(() => vi.clearAllMocks());

  test("keeps the subscription shape compatible while enriching unique changes", async () => {
    const instance = service();
    const stream = instance.subscribe();
    const publish = instance as unknown as {
      publish(
        id: string,
        reason: "REPORT_RECEIVED" | "CLEANUP_COMPLETED",
        cleanup?: {
          jobId: string;
          status: string;
          source: "AUTOMATIC";
          error: string | null;
          targets: never[];
          deleted: unknown[];
        },
      ): void;
    };

    publish.publish("agent-1", "REPORT_RECEIVED");
    const first = await stream.next();
    publish.publish("agent-1", "CLEANUP_COMPLETED", {
      jobId: "cleanup-1",
      status: "SUCCEEDED",
      source: "AUTOMATIC",
      error: null,
      targets: [],
      deleted: [{ path: "/DerivedData/App" }],
    });
    const second = await stream.next();
    await stream.return?.();

    expect(first.value).toMatchObject({
      diskSpaceChanged: "agent-1",
      diskSpaceChange: { reason: "REPORT_RECEIVED", cleanup: null },
    });
    expect(second.value).toMatchObject({
      diskSpaceChanged: "agent-1",
      diskSpaceChange: {
        reason: "CLEANUP_COMPLETED",
        cleanup: {
          jobId: "cleanup-1",
          deleted: [{ path: "/DerivedData/App" }],
        },
      },
    });
    expect(first.value.diskSpaceChange.id).not.toBe(
      second.value.diskSpaceChange.id,
    );
  });

  test("requests an immediate poll and records the report cursor", async () => {
    const requestDiskSpacePoll = vi.fn();
    const instance = new DiskSpaceService({
      registerCompletionObserver: vi.fn(),
      requestDiskSpacePoll,
    } as unknown as AgentControlService);
    vi.spyOn(instance, "agentView").mockResolvedValue({
      enabled: true,
      lastReportedAt: "2026-07-25T12:00:00.000Z",
    } as never);

    await expect(instance.requestRefresh("agent-1")).resolves.toMatchObject({
      agentId: "agent-1",
      previousReportedAt: "2026-07-25T12:00:00.000Z",
      requestedAt: expect.any(String),
    });
    expect(requestDiskSpacePoll).toHaveBeenCalledWith("agent-1");
  });

  test("publishes automatic cleanup targets and parsed deletion results", async () => {
    const requestDiskSpacePoll = vi.fn();
    const instance = new DiskSpaceService({
      registerCompletionObserver: vi.fn(),
      requestDiskSpacePoll,
    } as unknown as AgentControlService);
    getPrismaClient.mockResolvedValue({
      derivedDataCleanupLease: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      agentDiskSpaceState: { updateMany: vi.fn() },
    });
    const stream = instance.subscribe();

    await (
      instance as unknown as {
        observeCompletion(job: {
          id: string;
          agentId: string;
          kind: string;
          payloadJson: string;
          resultJson: string | null;
          status: string;
          error: string | null;
        }): Promise<void>;
      }
    ).observeCompletion({
      id: "cleanup-1",
      agentId: "agent-1",
      kind: BUILD_DATA_DELETE_JOB_KIND,
      payloadJson: JSON.stringify({
        source: "AUTOMATIC",
        targets: [{ path: "/DerivedData/App", rootPath: "/DerivedData" }],
      }),
      resultJson: JSON.stringify({
        deleted: [{ path: "/DerivedData/App", deleted: true, error: null }],
      }),
      status: "SUCCEEDED",
      error: null,
    });
    const event = await stream.next();
    await stream.return?.();

    expect(event.value.diskSpaceChange).toMatchObject({
      reason: "CLEANUP_COMPLETED",
      cleanup: {
        jobId: "cleanup-1",
        status: "SUCCEEDED",
        source: "AUTOMATIC",
        targets: [{ path: "/DerivedData/App", rootPath: "/DerivedData" }],
        deleted: [{ path: "/DerivedData/App", deleted: true, error: null }],
      },
    });
    expect(requestDiskSpacePoll).toHaveBeenCalledWith("agent-1");
  });

  test("rejects refresh when monitoring is disabled", async () => {
    const instance = service();
    vi.spyOn(instance, "agentView").mockResolvedValue({
      enabled: false,
    } as never);

    await expect(instance.requestRefresh("agent-1")).rejects.toThrow(
      "monitoring is disabled",
    );
  });
});

describe("DiskSpaceService cleanup selection", () => {
  beforeEach(() => vi.clearAllMocks());

  test.each([false, true])(
    "reclaims the oldest eligible Gradle project when Xcode data is present: %s",
    async (includeXcode) => {
      const gib = 1024 ** 3;
      const gradle = (id: string, time: number) => ({
        path: `/Builds/.android-gradle/${id}/cdb4ee2aea69cc6a`,
        rootPath: `/Builds/.android-gradle/${id}`,
        name: id,
        kind: "GRADLE_PROJECT",
        workspacePath: `/Repos/${id}`,
        modifiedAt: new Date(time).toISOString(),
        volumeId: "build-device",
      });
      const stale = gradle("stale", 0);
      const active = gradle("active", 1);
      const locked = gradle("locked", 2);
      const ready = gradle("ready", 3);
      const worktrees = [active, locked, ready]
        .map(({ name, workspacePath }) => ({
          id: name,
          folder: workspacePath,
        }))
        .concat({ id: "recreated", folder: stale.workspacePath });
      const xcode = {
        ...gradle("ready", 4),
        kind: "PROJECT",
        path: "/DerivedData/Ready-cache",
        rootPath: "/DerivedData",
      };
      const report = {
        observedAt: new Date().toISOString(),
        volumes: [
          {
            id: "build-device",
            totalBytes: 100 * gib,
            freeBytes: 20 * gib,
            roles: includeXcode
              ? ["DERIVED_DATA", "GRADLE_BUILD_DATA"]
              : ["GRADLE_BUILD_DATA"],
            paths: includeXcode
              ? ["/DerivedData", "/Builds/.android-gradle"]
              : ["/Builds/.android-gradle"],
          },
        ],
        entries: [
          stale,
          active,
          locked,
          ready,
          ...(includeXcode ? [xcode] : []),
        ],
        warnings: [],
      };
      const agent = {
        id: "agent-1",
        lastSeenAt: new Date(),
        disconnectedAt: null,
        baseRepoDirectory: "/Repos",
        capabilitiesJson: JSON.stringify([
          BUILD_DATA_DELETE_JOB_KIND,
          GRADLE_WORKTREE_CLEANUP_CAPABILITY,
        ]),
      };
      const create = vi.fn().mockResolvedValue({});
      const createJob = vi.fn().mockResolvedValue({ id: "delete-1" });
      const upsert = vi.fn(async ({ create }) => {
        Object.assign(state, create);
      });
      const state = {
        enabled: true,
        manualPressureMode: false,
        automaticPressureMode: false,
      };
      getPrismaClient.mockResolvedValue({
        diskSpaceSettings: {
          upsert: vi.fn().mockResolvedValue({
            normalThresholdGiB: 40,
            pressureThresholdGiB: 10,
          }),
        },
        agentDiskSpaceState: {
          upsert,
          findUnique: vi.fn().mockResolvedValue(state),
        },
        derivedDataLock: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([{ path: locked.path }])
            .mockResolvedValue([]),
        },
        derivedDataCleanupLease: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          findFirst: vi.fn().mockResolvedValue(null),
          create,
          update: vi.fn().mockResolvedValue({}),
        },
        agent: { findUnique: vi.fn().mockResolvedValue(agent) },
        worktree: {
          findMany: vi.fn().mockResolvedValue(worktrees),
          findFirst: vi.fn().mockResolvedValue({
            id: ready.name,
            folder: ready.workspacePath,
            gitDirectory: "/Repos/.git/worktrees/ready",
          }),
        },
      });
      vi.mocked(executingResourcesByWorktree).mockResolvedValueOnce(
        new Map([
          [
            active.name,
            [
              {
                kind: "BUILD",
                id: "build-1",
                label: "Build",
                href: "/dashboard/builds/build-1",
              },
            ],
          ],
        ]),
      );
      const instance = new DiskSpaceService({
        registerCompletionObserver: vi.fn(),
        createJob,
      } as unknown as AgentControlService);

      await instance.report(agent.id, report);

      await vi.waitFor(() =>
        expect(createJob).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            kind: BUILD_DATA_DELETE_JOB_KIND,
            payload: {
              source: "AUTOMATIC",
              targets: [
                expect.objectContaining({
                  path: ready.path,
                  kind: "GRADLE_PROJECT",
                  worktreeId: ready.name,
                  gitDirectory: "/Repos/.git/worktrees/ready",
                }),
              ],
            },
          }),
        ),
      );
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          worktreeId: ready.name,
          source: "AUTOMATIC",
        }),
      });
      expect(
        JSON.parse(upsert.mock.calls[0]![0].create.entriesJson),
      ).toContainEqual(
        expect.objectContaining({ path: stale.path, worktreeId: null }),
      );
    },
  );

  test("releases a failed Gradle cleanup lease and still blocks new work on a critical volume", async () => {
    const requestDiskSpacePoll = vi.fn();
    const registerCompletionObserver = vi.fn();
    const state = {
      enabled: true,
      lastReportedAt: new Date(),
      lastError: null,
      lastCleanupError: null,
      volumesJson: JSON.stringify([
        { roles: ["GRADLE_BUILD_DATA"], freeBytes: 0 },
      ]),
    };
    const updateMany = vi.fn(async ({ data }) => {
      Object.assign(state, data);
      return { count: 1 };
    });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const criticalDisk = prismaForState(state);
    getPrismaClient.mockResolvedValue({
      agentDiskSpaceState: { ...criticalDisk.agentDiskSpaceState, updateMany },
      diskSpaceSettings: {
        ...criticalDisk.diskSpaceSettings,
        findUnique: vi.fn().mockResolvedValue({ pressureThresholdGiB: 10 }),
      },
      derivedDataCleanupLease: {
        deleteMany,
        findUnique: vi.fn().mockResolvedValue(null),
      },
      agentJob: {
        findUnique: vi.fn().mockResolvedValue({
          agentId: "agent-1",
          kind: "android.build.run",
          status: "QUEUED",
          worktreeId: "worktree-1",
          payloadJson: "{}",
        }),
      },
    });
    const monitor = new DiskSpaceService({
      registerCompletionObserver,
      requestDiskSpacePoll,
    } as unknown as AgentControlService);
    const rootPath = "/Builds/.android-gradle/worktree-1";
    const path = `${rootPath}/cdb4ee2aea69cc6a`;
    await registerCompletionObserver.mock.calls[0]![0]({
      id: "delete-job",
      agentId: "agent-1",
      kind: BUILD_DATA_DELETE_JOB_KIND,
      status: "SUCCEEDED",
      error: null,
      payloadJson: JSON.stringify({
        source: "AUTOMATIC",
        targets: [{ path, rootPath, kind: "GRADLE_PROJECT" }],
      }),
      resultJson: JSON.stringify({
        deleted: [{ path, deleted: false, error: "Permission denied" }],
      }),
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { jobId: "delete-job" } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { agentId: "agent-1" },
      data: { lastCleanupError: "Permission denied" },
    });
    expect(requestDiskSpacePoll).not.toHaveBeenCalled();
    await expect(monitor.assertAgentCanStart("agent-1")).rejects.toThrow(
      "paused",
    );
    await expect(
      new AgentControlService().claimJob("agent-1", "build-1"),
    ).rejects.toThrow("paused");
  });

  test("cleans a Derived Data volume that shares APFS capacity with root", async () => {
    const gib = 1024 ** 3;
    const state = {
      enabled: true,
      lastReportedAt: new Date(),
      lastError: null,
      manualPressureMode: false,
      automaticPressureMode: false,
      volumesJson: JSON.stringify([
        {
          id: "root-device",
          capacityId: "apfs:disk3",
          totalBytes: 100 * gib,
          freeBytes: 20 * gib,
          roles: ["MAIN"],
          paths: ["/"],
        },
        {
          id: "data-device",
          capacityId: "apfs:disk3",
          totalBytes: 100 * gib,
          freeBytes: 20 * gib,
          roles: ["DERIVED_DATA"],
          paths: ["/DerivedData"],
        },
      ]),
      entriesJson: JSON.stringify([
        {
          path: "/DerivedData/App-hash",
          rootPath: "/DerivedData",
          name: "App-hash",
          kind: "PROJECT",
          workspacePath: "/Repos/App/App.xcodeproj",
          modifiedAt: new Date(0).toISOString(),
          volumeId: "data-device",
          worktreeId: "worktree-1",
          worktreePath: "App",
        },
      ]),
    };
    const updateState = vi.fn().mockResolvedValue(state);
    const createJob = vi.fn().mockResolvedValue({ id: "delete-1" });
    getPrismaClient.mockResolvedValue({
      diskSpaceSettings: {
        upsert: vi.fn().mockResolvedValue({
          normalThresholdGiB: 40,
          pressureThresholdGiB: 10,
        }),
      },
      agentDiskSpaceState: {
        findUnique: vi.fn().mockResolvedValue(state),
        update: updateState,
      },
      derivedDataLock: { findMany: vi.fn().mockResolvedValue([]) },
      derivedDataCleanupLease: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "agent-1",
          disconnectedAt: null,
          lastSeenAt: new Date(),
          capabilitiesJson: '["buildData.delete"]',
        }),
      },
    });
    const instance = new DiskSpaceService({
      registerCompletionObserver: vi.fn(),
      createJob,
    } as unknown as AgentControlService) as unknown as {
      reconcileAgent(agentId: string): Promise<void>;
    };

    await instance.reconcileAgent("agent-1");

    expect(updateState).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { automaticPressureMode: true } }),
    );
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ source: "AUTOMATIC" }),
      }),
    );
  });

  test("leaves a low main disk alone when Derived Data has room", async () => {
    const gib = 1024 ** 3;
    const state = {
      enabled: true,
      lastReportedAt: new Date(),
      lastError: null,
      manualPressureMode: false,
      automaticPressureMode: false,
      volumesJson: JSON.stringify([
        {
          id: "root-device",
          capacityId: "apfs:disk1",
          totalBytes: 100 * gib,
          freeBytes: 5 * gib,
          roles: ["MAIN", "BASE_REPO"],
          paths: ["/"],
        },
        {
          id: "data-device",
          capacityId: "apfs:disk3",
          totalBytes: 100 * gib,
          freeBytes: 80 * gib,
          roles: ["DERIVED_DATA"],
          paths: ["/Volumes/Data/DerivedData"],
        },
      ]),
      entriesJson: JSON.stringify([
        {
          path: "/Volumes/Data/DerivedData/App-hash",
          rootPath: "/Volumes/Data/DerivedData",
          name: "App-hash",
          kind: "PROJECT",
          workspacePath: "/Repos/App/App.xcodeproj",
          modifiedAt: new Date(0).toISOString(),
          volumeId: "data-device",
          worktreeId: "worktree-1",
          worktreePath: "App",
        },
      ]),
    };
    const updateState = vi.fn().mockResolvedValue(state);
    const createJob = vi.fn().mockResolvedValue({ id: "delete-1" });
    getPrismaClient.mockResolvedValue({
      diskSpaceSettings: {
        upsert: vi.fn().mockResolvedValue({
          normalThresholdGiB: 40,
          pressureThresholdGiB: 10,
        }),
      },
      agentDiskSpaceState: {
        findUnique: vi.fn().mockResolvedValue(state),
        update: updateState,
      },
      derivedDataLock: { findMany: vi.fn().mockResolvedValue([]) },
      derivedDataCleanupLease: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "agent-1",
          disconnectedAt: null,
          lastSeenAt: new Date(),
          capabilitiesJson: '["buildData.delete"]',
        }),
      },
    });
    const instance = new DiskSpaceService({
      registerCompletionObserver: vi.fn(),
      createJob,
    } as unknown as AgentControlService) as unknown as {
      reconcileAgent(agentId: string): Promise<void>;
    };

    await instance.reconcileAgent("agent-1");

    expect(updateState).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });
});
