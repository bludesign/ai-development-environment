import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
import {
  CODEBASE_BRANCHES_DELETE_JOB_KIND,
  type CodebaseSnapshot,
} from "@ai-development-environment/agent-contract/codebases";
import type { AgentControlService } from "@/services/agent-control";
import { CodebasesService } from "./codebases.service";

const sha = "a".repeat(40);
const codebase = (id: string) => ({
  id,
  agentId: `agent-${id}`,
  folder: `/${id}`,
  repositoryId: "repo",
  repository: { canonicalOrigin: "example.com/app" },
  defaultBranch: "main",
  availability: "AVAILABLE",
  agent: {
    lastSeenAt: new Date(),
    disconnectedAt: null,
    capabilitiesJson: JSON.stringify([CODEBASE_BRANCHES_DELETE_JOB_KIND]),
  },
  jobs: [],
});
const snapshot: CodebaseSnapshot = {
  folder: "/a",
  observedOrigin: "https://example.com/app.git",
  canonicalOrigin: "example.com/app",
  displayOrigin: "example.com/app",
  branch: "main",
  headSha: sha,
  upstream: null,
  ahead: null,
  behind: null,
  syncState: "NO_UPSTREAM",
  availability: "AVAILABLE",
  error: null,
  checkedAt: new Date().toISOString(),
  fetchedAt: null,
  linkedWorktree: false,
};
beforeEach(() => vi.clearAllMocks());

describe("branch cleanup scheduling and cache", () => {
  test("groups selections by checkout, isolates failures, and replays identical requests without new jobs", async () => {
    const stored = new Map<string, object>();
    const createJob = vi.fn(async (input) => {
      const job = {
        ...input,
        id: `job-${input.codebaseId}`,
        payloadJson: JSON.stringify(input.payload),
      };
      stored.set(input.idempotencyKey, job);
      return job;
    });
    getPrismaClient.mockResolvedValue({
      agentJob: {
        deleteMany: vi.fn(),
        findFirst: vi.fn(
          async ({ where }) => stored.get(where.idempotencyKey) ?? null,
        ),
      },
      codebase: {
        findUnique: vi.fn(async ({ where }) =>
          where.id === "offline"
            ? {
                ...codebase("offline"),
                agent: {
                  ...codebase("offline").agent,
                  disconnectedAt: new Date(),
                },
              }
            : codebase(where.id),
        ),
      },
    });
    const service = new CodebasesService({
      createJob,
      registerCompletionHandler: vi.fn(),
    } as unknown as AgentControlService);
    const input = {
      requestId: "request",
      targets: ["a", "a", "b", "offline"].map((id, index) => ({
        codebaseId: id,
        branch: index === 1 ? "second" : "feature",
        expectedHeadSha: sha,
      })),
    };
    const first = await service.deleteBranches(input);
    const second = await service.deleteBranches(input);
    expect(first.jobs).toHaveLength(2);
    expect(first.skipped).toEqual([
      expect.objectContaining({
        codebaseId: "offline",
        outcome: "SKIPPED",
        reason: "Agent is offline",
      }),
    ]);
    expect(second.jobs).toHaveLength(2);
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(createJob.mock.calls[0]![0]).toMatchObject({
      agentId: "agent-a",
      codebaseId: "a",
      kind: CODEBASE_BRANCHES_DELETE_JOB_KIND,
      payload: {
        folder: "/a",
        force: false,
        targets: [
          expect.objectContaining({ branch: "feature" }),
          expect.objectContaining({ branch: "second" }),
        ],
      },
    });
    expect(
      (await service.deleteBranches({ ...input, force: true })).skipped[0]
        ?.reason,
    ).toContain("different branch selection");
  });

  test("retains the successful cache after failed scans and leaves older-agent reports compatible", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      codebase: {
        findUnique: vi.fn().mockResolvedValue(codebase("a")),
        updateMany,
      },
    });
    const service = new CodebasesService({
      registerCompletionHandler: vi.fn(),
    } as unknown as AgentControlService);
    const inventory = {
      scannedAt: "2026-10-01T00:00:00.000Z",
      branches: [
        {
          name: "feature",
          headSha: sha,
          lastCommitAt: null,
          lastCommitMessage: null,
          current: false,
          checkedOutPath: null,
        },
      ],
    };
    await service.report("agent-a", [
      {
        codebaseId: "a",
        snapshot,
        localBranchInventory: inventory,
        localBranchInventoryAttemptedAt: inventory.scannedAt,
      },
    ]);
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentId: "agent-a",
          OR: [
            { localBranchInventoryAttemptedAt: null },
            {
              localBranchInventoryAttemptedAt: {
                lt: new Date(inventory.scannedAt),
              },
            },
          ],
        }),
        data: expect.objectContaining({
          localBranchInventoryJson: JSON.stringify(inventory),
        }),
      }),
    );
    await service.report("agent-a", [
      {
        codebaseId: "a",
        snapshot,
        localBranchInventory: null,
        localBranchInventoryError: "Scan failed",
        localBranchInventoryAttemptedAt: "2026-10-01T00:01:00Z",
      },
    ]);
    const last = updateMany.mock.calls.at(-1)![0];
    expect(last.data).toMatchObject({
      localBranchInventoryError: "Scan failed",
    });
    expect(last.data).not.toHaveProperty("localBranchInventoryJson");
    updateMany.mockClear();
    await service.report("agent-a", [{ codebaseId: "a", snapshot }]);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]![0].data).not.toHaveProperty(
      "localBranchInventoryAttemptedAt",
    );
  });
});
