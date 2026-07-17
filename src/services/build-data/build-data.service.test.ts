import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

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

  test("rejects operations when an agent went offline after its scan", async () => {
    const collection = collectionWithOperation();
    const prisma = {
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
        targets: [
          { path: "/DerivedData/App-hash", rootPath: "/DerivedData" },
        ],
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
