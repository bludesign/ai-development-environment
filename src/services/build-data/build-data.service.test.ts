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
});
