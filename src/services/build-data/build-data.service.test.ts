import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
vi.mock("@/services/disk-space/executing-work", () => ({
  executingResourcesByWorktree: vi.fn(
    async (ids: string[]) => new Map(ids.map((id) => [id, []])),
  ),
}));

import type { AgentControlService } from "@/services/agent-control";

import { BuildDataService } from "./build-data.service";

function agent() {
  return {
    id: "agent-1",
    name: "Builder",
    hostname: "builder.local",
    version: "0.1.0",
    osVersion: "macOS",
    architecture: "arm64",
    cpuModel: null,
    memoryTotalBytes: null,
    memoryFreeBytes: null,
    diskTotalBytes: null,
    diskFreeBytes: null,
    capabilitiesJson: '["buildData.scan","buildData.size","buildData.delete"]',
    secretHash: "hash",
    baseRepoDirectory: "/Repos",
    derivedDataLocationMode: "DEFAULT",
    derivedDataPath: null,
    ipAddress: null,
    lastSeenAt: new Date(),
    disconnectedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const unlockedEntries = () => ({
  derivedDataLock: { findMany: vi.fn().mockResolvedValue([]) },
});

function collectionWithOperation(operation?: {
  id: string;
  kind: "buildData.size" | "buildData.delete";
  resultJson: string;
}) {
  const persistedAgent = agent();
  return {
    id: "collection-1",
    deadlineAt: new Date(Date.now() + 60_000),
    finishedAt: new Date(),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    agents: [
      {
        collectionId: "collection-1",
        agentId: persistedAgent.id,
        initialStatus: "QUEUING",
        error: null,
        agent: persistedAgent,
      },
    ],
    jobs: [
      {
        id: "scan-1",
        agentId: persistedAgent.id,
        kind: "buildData.scan",
        status: "SUCCEEDED",
        resultJson: JSON.stringify({
          entries: [
            {
              path: "/DerivedData/App-hash",
              rootPath: "/DerivedData",
              name: "App-hash",
              kind: "PROJECT",
              workspacePath: null,
            },
          ],
          warnings: [],
        }),
        error: null,
        payloadJson: "{}",
        createdAt: new Date(0),
      },
      ...(operation
        ? [
            {
              ...operation,
              agentId: persistedAgent.id,
              status: "SUCCEEDED",
              error: null,
              payloadJson: JSON.stringify({
                targets: [
                  {
                    path: "/DerivedData/App-hash",
                    rootPath: "/DerivedData",
                  },
                ],
              }),
              createdAt: new Date(1),
            },
          ]
        : []),
    ],
  };
}

describe("BuildDataService", () => {
  beforeEach(() => vi.clearAllMocks());

  test("matches WorkspacePath to the longest same-agent worktree and overlays calculated size", async () => {
    const persistedAgent = agent();
    const collection = {
      id: "collection-1",
      deadlineAt: new Date(Date.now() + 60_000),
      finishedAt: new Date(),
      createdAt: new Date(0),
      updatedAt: new Date(0),
      agents: [
        {
          collectionId: "collection-1",
          agentId: persistedAgent.id,
          initialStatus: "QUEUING",
          error: null,
          agent: persistedAgent,
        },
      ],
      jobs: [
        {
          id: "scan-1",
          agentId: persistedAgent.id,
          kind: "buildData.scan",
          status: "SUCCEEDED",
          resultJson: JSON.stringify({
            entries: [
              {
                path: "/DerivedData/App-hash",
                rootPath: "/DerivedData",
                name: "App-hash",
                kind: "PROJECT",
                workspacePath: "/Repos/App/Sub/App.xcodeproj",
              },
              {
                path: "/DerivedData/Starting-hash",
                rootPath: "/DerivedData",
                name: "Starting-hash",
                kind: "PENDING",
                workspacePath: null,
              },
            ],
            warnings: [],
          }),
          error: null,
          payloadJson: "{}",
          createdAt: new Date(0),
        },
        {
          id: "size-1",
          agentId: persistedAgent.id,
          kind: "buildData.size",
          status: "SUCCEEDED",
          resultJson: JSON.stringify({
            sizes: [
              { path: "/DerivedData/App-hash", sizeBytes: 4096, error: null },
            ],
          }),
          error: null,
          payloadJson: "{}",
          createdAt: new Date(1),
        },
      ],
    };
    const prisma = {
      ...unlockedEntries(),
      buildDataDeletionHistory: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      buildDataCollection: {
        findUnique: vi.fn().mockResolvedValue(collection),
      },
      worktree: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "worktree-root",
            folder: "/Repos/App",
            codebase: { agentId: "agent-1" },
          },
          {
            id: "worktree-nested",
            folder: "/Repos/App/Sub",
            codebase: { agentId: "agent-1" },
          },
        ]),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const agentControl = {
      registerCompletionHandler: vi.fn(),
    } as unknown as AgentControlService;

    const snapshot = await new BuildDataService(agentControl).getCollection(
      "collection-1",
    );

    expect(snapshot?.entries[0]).toMatchObject({
      name: "App-hash",
      status: "READY",
      worktreeId: "worktree-nested",
      worktreePath: "App/Sub",
      sizeBytes: 4096,
    });
    expect(snapshot?.entries[1]).toMatchObject({
      name: "Starting-hash",
      status: "PENDING",
      worktreeId: null,
      worktreePath: null,
    });
  });

  test("prunes records older than 90 days and returns cursor-paginated history", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const items = [
      { id: "new", deletedAt: new Date(), folderName: "New" },
      { id: "older", deletedAt: new Date(1), folderName: "Older" },
    ];
    getPrismaClient.mockResolvedValue({
      buildDataDeletionHistory: {
        deleteMany,
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue(items),
      },
    });
    const service = new BuildDataService({
      registerCompletionHandler: vi.fn(),
    } as unknown as AgentControlService);

    const page = await service.history(1);

    expect(deleteMany).toHaveBeenCalledWith({
      where: { deletedAt: { lt: expect.any(Date) } },
    });
    expect(page.items).toEqual([items[0]]);
    expect(page.nextCursor).toBe("new");
  });

  test("scopes history at the cursor and data queries and clears only the selected agent", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi
      .fn()
      .mockResolvedValue({ id: "cursor", deletedAt: new Date() });
    const findMany = vi.fn().mockResolvedValue([]);
    getPrismaClient.mockResolvedValue({
      buildDataDeletionHistory: { deleteMany, findUnique, findMany },
    });
    const service = new BuildDataService({
      registerCompletionHandler: vi.fn(),
    } as unknown as AgentControlService);

    await service.history(3, "cursor", "agent-1");
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cursor", agentId: "agent-1" } }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 4,
        where: expect.objectContaining({
          agentId: "agent-1",
          OR: expect.any(Array),
        }),
      }),
    );
    expect(await service.clearHistory("agent-1")).toBe(1);
    expect(deleteMany).toHaveBeenLastCalledWith({
      where: { agentId: "agent-1" },
    });
  });

  test("labels legacy Device Support entries as iOS and preserves reported platforms", async () => {
    const collection = collectionWithOperation();
    collection.jobs[0]!.resultJson = JSON.stringify({
      entries: [
        {
          path: "/Xcode/iOS DeviceSupport/26.2",
          rootPath: "/Xcode/iOS DeviceSupport",
          name: "26.2",
          kind: "DEVICE_SUPPORT",
          workspacePath: null,
        },
        {
          path: "/Xcode/tvOS DeviceSupport/26.2",
          rootPath: "/Xcode/tvOS DeviceSupport",
          name: "26.2",
          kind: "DEVICE_SUPPORT",
          deviceSupportPlatform: "tvOS",
          workspacePath: null,
        },
      ],
      warnings: [],
    });
    getPrismaClient.mockResolvedValue({
      ...unlockedEntries(),
      buildDataCollection: {
        findUnique: vi.fn().mockResolvedValue(collection),
      },
      buildDataDeletionHistory: { deleteMany: vi.fn() },
      worktree: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const service = new BuildDataService({
      registerCompletionHandler: vi.fn(),
    } as unknown as AgentControlService);

    const result = await service.getCollection(collection.id);
    expect(
      result?.entries.map((entry) => entry.deviceSupportPlatform).sort(),
    ).toEqual(["iOS", "tvOS"]);
  });

  test("scopes a new scan to one agent and rejects reuse of its request ID with a different scope", async () => {
    const collection = collectionWithOperation();
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(collection)
      .mockResolvedValueOnce(collection)
      .mockResolvedValueOnce({ agentId: "agent-1" });
    const create = vi.fn().mockResolvedValue({ agentId: "agent-1" });
    const listAgents = vi
      .fn()
      .mockResolvedValue([agent(), { ...agent(), id: "agent-2" }]);
    getPrismaClient.mockResolvedValue({
      ...unlockedEntries(),
      buildDataDeletionHistory: { deleteMany: vi.fn() },
      buildDataCollection: { findUnique, create },
      worktree: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const service = new BuildDataService({
      registerCompletionHandler: vi.fn(),
      listAgents,
    } as unknown as AgentControlService);

    await service.refresh("collection-1", "agent-1");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentId: "agent-1",
          agents: {
            create: [{ agentId: "agent-1", initialStatus: "QUEUING" }],
          },
        }),
      }),
    );
    await expect(service.refresh("collection-1", "agent-2")).rejects.toThrow(
      "different agent scope",
    );
  });

  test("rejects operations when an agent went offline after its scan", async () => {
    const collection = collectionWithOperation();
    const prisma = {
      ...unlockedEntries(),
      buildDataDeletionHistory: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      buildDataCollection: {
        findUnique: vi.fn().mockResolvedValue(collection),
      },
      worktree: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          ...collection.agents[0]!.agent,
          disconnectedAt: new Date(),
        }),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const createJob = vi.fn();
    const service = new BuildDataService({
      registerCompletionHandler: vi.fn(),
      createJob,
    } as unknown as AgentControlService);
    const snapshot = await service.getCollection(collection.id);

    await expect(
      service.deleteEntries(
        collection.id,
        [snapshot!.entries[0]!.id],
        "request-1",
      ),
    ).rejects.toThrow("Builder is offline");
    expect(createJob).not.toHaveBeenCalled();
  });

  test("keeps user deletion payloads compatible with legacy agents", async () => {
    const collection = collectionWithOperation();
    const prisma = {
      ...unlockedEntries(),
      buildDataDeletionHistory: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      buildDataCollection: {
        findUnique: vi.fn().mockResolvedValue(collection),
      },
      worktree: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue(collection.agents[0]!.agent),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const createJob = vi.fn().mockResolvedValue({ id: "delete-1" });
    const service = new BuildDataService({
      registerCompletionHandler: vi.fn(),
      createJob,
    } as unknown as AgentControlService);
    const snapshot = await service.getCollection(collection.id);

    await service.deleteEntries(
      collection.id,
      [snapshot!.entries[0]!.id],
      "request-1",
    );

    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "buildData.delete",
        payload: {
          targets: [
            {
              path: "/DerivedData/App-hash",
              rootPath: "/DerivedData",
            },
          ],
        },
      }),
    );
  });

  test("holds provisional user cleanup leases for the full job timeout", async () => {
    const collection = collectionWithOperation();
    collection.jobs[0]!.resultJson = JSON.stringify({
      entries: [
        {
          path: "/DerivedData/App-hash",
          rootPath: "/DerivedData",
          name: "App-hash",
          kind: "PROJECT",
          workspacePath: "/Repos/App/App.xcodeproj",
        },
      ],
      warnings: [],
    });
    const createLease = vi.fn().mockResolvedValue({});
    const prisma = {
      ...unlockedEntries(),
      buildDataDeletionHistory: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      buildDataCollection: {
        findUnique: vi.fn().mockResolvedValue(collection),
      },
      worktree: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "worktree-1",
            folder: "/Repos/App",
            codebase: { agentId: "agent-1" },
          },
        ]),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue(collection.agents[0]!.agent),
      },
      derivedDataCleanupLease: {
        create: createLease,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const service = new BuildDataService({
      registerCompletionHandler: vi.fn(),
      createJob: vi.fn().mockResolvedValue({ id: "delete-1" }),
    } as unknown as AgentControlService);
    const snapshot = await service.getCollection(collection.id);
    const startedAt = Date.now();

    await service.deleteEntries(
      collection.id,
      [snapshot!.entries[0]!.id],
      "request-1",
    );

    const expiresAt = createLease.mock.calls[0]?.[0].data.expiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(
      startedAt + 7 * 24 * 60 * 60 * 1_000,
    );
  });

  test.each([
    {
      kind: "buildData.size" as const,
      resultJson: JSON.stringify({ sizes: "invalid" }),
      expectedError:
        "Invalid Build Data size result: build data size result.sizes must be an array",
    },
    {
      kind: "buildData.delete" as const,
      resultJson: JSON.stringify({ deleted: "invalid" }),
      expectedError:
        "Invalid Build Data delete result: build data delete result.deleted must be an array",
    },
  ])("surfaces an invalid $kind result on its target entry", async (input) => {
    const collection = collectionWithOperation({ id: "operation-1", ...input });
    getPrismaClient.mockResolvedValue({
      ...unlockedEntries(),
      buildDataDeletionHistory: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      buildDataCollection: {
        findUnique: vi.fn().mockResolvedValue(collection),
      },
      worktree: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const service = new BuildDataService({
      registerCompletionHandler: vi.fn(),
    } as unknown as AgentControlService);

    const snapshot = await service.getCollection(collection.id);

    expect(snapshot!.entries[0]).toMatchObject({
      operation: "IDLE",
      error: input.expectedError,
    });
  });

  test("records malformed delete results as invalid projections without retrying", async () => {
    let completionHandler:
      | Parameters<AgentControlService["registerCompletionHandler"]>[1]
      | undefined;
    const registerCompletionHandler = vi.fn((kind, handler) => {
      if (kind === "buildData.delete") completionHandler = handler;
    });
    const projection = {
      jobId: "delete-1",
      error:
        "Invalid Build Data delete result: build data delete result.deleted must be an array",
    };
    const create = vi.fn().mockResolvedValue(projection);
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(projection);
    getPrismaClient.mockResolvedValue({
      buildDataDeletionHistory: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      buildDataDeleteProjection: { findUnique, create },
    });
    new BuildDataService({
      registerCompletionHandler,
    } as unknown as AgentControlService);
    const job = {
      id: "delete-1",
      agentId: "agent-1",
      codebaseId: null,
      worktreeId: null,
      buildDataCollectionId: "collection-1",
      kind: "buildData.delete",
      payloadJson: JSON.stringify({
        targets: [{ path: "/DerivedData/App-hash", rootPath: "/DerivedData" }],
      }),
      status: "SUCCEEDED",
      resultJson: JSON.stringify({ deleted: "invalid" }),
      error: null,
    };

    await expect(completionHandler!(job)).resolves.toBeUndefined();
    await expect(completionHandler!(job)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ data: projection });
  });
});
