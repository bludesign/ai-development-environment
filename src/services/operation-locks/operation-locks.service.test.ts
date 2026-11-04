// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import {
  sourceBranchResource,
  type OperationDescriptor,
} from "@ai-development-environment/agent-contract/operation-resources";
import { AgentControlService } from "@/services/agent-control/agent-control.service";
import { SETTLED_AGENT_JOB_WHERE } from "@/services/agent-control/job-cleanup";
import { WorktreesService } from "@/services/worktrees/worktrees.service";
import {
  admitOperation,
  recoverMergeReservations,
  releaseOperation,
  requestOperation,
  ResourceBusyError,
  withMergeReservation,
} from "./operation-locks.service";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

let prisma: PrismaClient;
let directory: string;
let file: string;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "aide-operation-locks-"));
  file = join(directory, "test.db");
  // Migrate in memory so CI does not sync every schema statement to disk.
  // Prisma still uses the on-disk backup for real cross-connection locking.
  const database = new Database(":memory:");
  try {
    for (const migration of readdirSync("prisma/migrations", {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      database.exec(
        readFileSync(
          join("prisma/migrations", migration, "migration.sql"),
          "utf8",
        ),
      );
    }
    await database.backup(file);
  } finally {
    database.close();
  }
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: file }),
  });
  getPrismaClient.mockResolvedValue(prisma);
  await prisma.agent.create({
    data: {
      id: "agent",
      name: "Test",
      hostname: "test",
      version: "test",
      osVersion: "test",
      architecture: "arm64",
      secretHash: "test",
      capabilitiesJson: '["operation.resources.v1"]',
    },
  });
  await prisma.codebaseRepository.create({
    data: {
      id: "repo",
      canonicalOrigin: "github.com/acme/app",
      displayOrigin: "github.com/acme/app",
      name: "App",
    },
  });
  await prisma.codebase.create({
    data: {
      id: "codebase",
      agentId: "agent",
      repositoryId: "repo",
      folder: "/repo",
      observedOrigin: "github.com/acme/app",
    },
  });
  for (const id of ["a", "b", "c"])
    await prisma.worktree.create({
      data: {
        id,
        codebaseId: "codebase",
        folder: `/repo/${id}`,
        gitDirectory: `/repo/.git/worktrees/${id}`,
        relativePath: id,
        branch: `feature/${id}`,
      },
    });
});
beforeEach(async () => {
  await prisma.operationResource.deleteMany();
  await prisma.operationHolder.deleteMany();
  await prisma.operationAdmissionLane.deleteMany();
  await prisma.agentJob.deleteMany();
  for (const id of ["a", "b", "c"])
    await prisma.worktree.update({
      where: { id },
      data: { branch: `feature/${id}`, headSha: null },
    });
});
afterAll(async () => {
  await prisma?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function descriptor(
  worktree: string,
  mode: "BUILD" | "WRITE" | "READ" = "BUILD",
): OperationDescriptor {
  return {
    version: 1,
    resources: [
      {
        kind: "WORKTREE",
        key: `agent:worktree:/repo/.git/worktrees/${worktree}`,
        mode,
        agentId: "agent",
        codebaseId: "codebase",
      },
      {
        kind: "PATH",
        key: `agent:path:/repo/${worktree}`,
        path: `/repo/${worktree}`,
        mode,
        agentId: "agent",
        codebaseId: "codebase",
      },
      ...(mode === "BUILD"
        ? [
            {
              kind: "WORKTREE" as const,
              key: `agent:build-stability:/repo/.git/worktrees/${worktree}`,
              mode: "WRITE" as const,
              agentId: "agent",
              codebaseId: "codebase",
            },
          ]
        : []),
      ...(mode === "READ"
        ? []
        : [sourceBranchResource("github.com/acme/app", `feature/${worktree}`)]),
    ],
  };
}
async function enqueue(
  id: string,
  worktree: string,
  mode: "BUILD" | "WRITE" | "READ" = "BUILD",
  resources = descriptor(worktree, mode),
) {
  const job = await prisma.agentJob.create({
    data: {
      id,
      agentId: "agent",
      codebaseId: "codebase",
      worktreeId: worktree,
      kind:
        mode === "BUILD"
          ? "ios.build.run"
          : mode === "READ"
            ? "worktree.inspect"
            : "worktree.commit",
      payloadJson: "{}",
      status: "QUEUED",
      idempotencyKey: id,
      timeoutSeconds: 60,
      operationResourcesJson: JSON.stringify(resources),
    },
  });
  await prisma.$transaction((transaction) =>
    requestOperation(transaction, "AGENT_JOB", id, resources),
  );
  return job;
}

describe("durable worktree admission with real SQLite", () => {
  test("preserves execution acknowledgements when an agent is deleted", async () => {
    const service = new AgentControlService();
    await enqueue("agent-deletion", "a", "WRITE");
    await service.claimJob("agent", "agent-deletion", "execution-owner");
    await expect(service.deleteAgent("agent")).rejects.toBeInstanceOf(
      ResourceBusyError,
    );
    expect(
      await prisma.agentJob.findUnique({ where: { id: "agent-deletion" } }),
    ).toMatchObject({
      status: "RUNNING",
      executionToken: "execution-owner",
    });
    await service.completeJob(
      "agent",
      "agent-deletion",
      "CANCELLED",
      undefined,
      null,
      "execution-owner",
    );
    await expect(
      prisma.$transaction((tx) =>
        admitOperation(
          tx,
          "TEST_WRITE",
          "after-agent-deletion",
          descriptor("a", "WRITE"),
          "writer",
        ),
      ),
    ).resolves.toMatchObject({ state: "HELD" });
  });

  test("retires queued reservations when their agent is deleted", async () => {
    await prisma.agent.create({
      data: {
        id: "removable-agent",
        name: "Removable",
        capabilitiesJson: "[]",
        hostname: "test",
        version: "test",
        osVersion: "test",
        architecture: "arm64",
        secretHash: "removable-test",
      },
    });
    const resources: OperationDescriptor = {
      version: 1,
      resources: [
        {
          kind: "AGENT",
          key: "agent:removable-agent",
          mode: "WRITE",
          agentId: "removable-agent",
        },
        {
          ...sourceBranchResource("github.com/acme/app", "feature/a"),
          agentId: "removable-agent",
        },
      ],
    };
    try {
      await prisma.$transaction((tx) =>
        requestOperation(tx, "AGENT_JOB", "removable-job", resources),
      );
      await new AgentControlService().deleteAgent("removable-agent");
      expect(
        await prisma.operationHolder.findUnique({
          where: {
            ownerKind_ownerId: {
              ownerKind: "AGENT_JOB",
              ownerId: "removable-job",
            },
          },
        }),
      ).toMatchObject({ state: "RELEASED" });
      await expect(
        prisma.$transaction((tx) =>
          admitOperation(
            tx,
            "MERGE_SUBMISSION",
            "after-deletion",
            {
              version: 1,
              resources: [
                sourceBranchResource(
                  "github.com/acme/app",
                  "feature/a",
                  "WRITE",
                ),
              ],
            },
            "merge",
          ),
        ),
      ).resolves.toMatchObject({ state: "HELD" });
    } finally {
      await prisma.agent.deleteMany({ where: { id: "removable-agent" } });
    }
  });

  test("retains a timed-out inspection until the agent acknowledges cancellation", async () => {
    const service = new AgentControlService();
    const worktrees = new WorktreesService(service, {} as never, {} as never);
    await prisma.agent.update({
      where: { id: "agent" },
      data: {
        capabilitiesJson: '["operation.resources.v1","worktree.git.inspect"]',
        lastSeenAt: new Date(),
      },
    });
    const claimed = Promise.withResolvers<string>();
    const createJob = service.createJob.bind(service);
    const spy = vi
      .spyOn(service, "createJob")
      .mockImplementationOnce(async (input) => {
        const job = await createJob(input);
        await service.claimJob("agent", job.id, "inspection-owner");
        claimed.resolve(job.id);
        return job;
      });
    vi.useFakeTimers();
    try {
      const timeout = expect(
        worktrees.refreshGitState("a", "inspection-timeout"),
      ).rejects.toThrow("Agent did not respond in time");
      const jobId = await claimed.promise;
      await vi.advanceTimersByTimeAsync(30_001);
      await timeout;
      expect(
        await prisma.agentJob.findUnique({ where: { id: jobId } }),
      ).toMatchObject({
        status: "CANCELLING",
        executionToken: "inspection-owner",
      });
      await expect(
        prisma.$transaction((tx) =>
          admitOperation(
            tx,
            "TEST_WRITE",
            "after-inspection",
            descriptor("a", "WRITE"),
            "writer",
          ),
        ),
      ).rejects.toBeInstanceOf(ResourceBusyError);

      await service.completeJob(
        "agent",
        jobId,
        "CANCELLED",
        undefined,
        null,
        "inspection-owner",
      );
      await expect(
        prisma.$transaction((tx) =>
          admitOperation(
            tx,
            "TEST_WRITE",
            "after-inspection",
            descriptor("a", "WRITE"),
            "writer",
          ),
        ),
      ).resolves.toMatchObject({ state: "HELD" });
      expect(
        await prisma.agentJob.deleteMany({
          where: { id: jobId, AND: [SETTLED_AGENT_JOB_WHERE] },
        }),
      ).toMatchObject({ count: 1 });
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  test("does not prune terminal jobs while execution cleanup is still pending", async () => {
    const service = new AgentControlService();
    await enqueue("terminal-inspection", "a", "READ");
    await service.claimJob("agent", "terminal-inspection", "inspection-owner");
    await prisma.agentJob.update({
      where: { id: "terminal-inspection" },
      data: { status: "TIMED_OUT", finishedAt: new Date() },
    });
    const where = { id: "terminal-inspection", AND: [SETTLED_AGENT_JOB_WHERE] };
    expect(await prisma.agentJob.deleteMany({ where })).toMatchObject({
      count: 0,
    });
    await service.completeJob(
      "agent",
      "terminal-inspection",
      "CANCELLED",
      undefined,
      null,
      "inspection-owner",
    );
    expect(await prisma.agentJob.deleteMany({ where })).toMatchObject({
      count: 1,
    });
    expect(
      await prisma.operationHolder.findUnique({
        where: {
          ownerKind_ownerId: {
            ownerKind: "AGENT_JOB",
            ownerId: "terminal-inspection",
          },
        },
      }),
    ).toMatchObject({ state: "RELEASED" });
  });

  test("long session readers cannot bypass an earlier repository barrier", async () => {
    await enqueue("build", "a");
    await new AgentControlService().claimJob("agent", "build", "build");
    const barrier: OperationDescriptor = {
      version: 1,
      resources: [
        {
          kind: "CODEBASE",
          key: "agent:codebase:codebase",
          agentId: "agent",
          codebaseId: "codebase",
          mode: "WRITE",
        },
      ],
    };
    await prisma.$transaction((transaction) =>
      requestOperation(transaction, "BARRIER", "waiting-barrier", barrier),
    );
    await prisma.operationHolder.update({
      where: {
        ownerKind_ownerId: { ownerKind: "BARRIER", ownerId: "waiting-barrier" },
      },
      data: { createdAt: new Date(0) },
    });
    const session: OperationDescriptor = {
      version: 1,
      resources: [
        {
          kind: "WORKTREE",
          key: "agent:build-stability:/repo/.git/worktrees/b",
          agentId: "agent",
          codebaseId: "codebase",
          mode: "READ",
        },
      ],
    };
    await expect(
      prisma.$transaction((transaction) =>
        admitOperation(transaction, "AGENT_RUN", "session", session, "session"),
      ),
    ).rejects.toBeInstanceOf(ResourceBusyError);
    await expect(
      prisma.$transaction((transaction) =>
        admitOperation(
          transaction,
          "AGENT_JOB",
          "inspection",
          descriptor("b", "READ"),
          "inspection",
        ),
      ),
    ).resolves.toMatchObject({ state: "HELD" });
  });

  test("legacy interrupted source work retains its coarse lease until original completion", async () => {
    const resources: OperationDescriptor = {
      version: 1,
      resources: [
        {
          kind: "CODEBASE",
          key: "agent:codebase:codebase",
          mode: "WRITE",
          agentId: "agent",
          codebaseId: "codebase",
        },
      ],
    };
    await enqueue("legacy", "a", "BUILD", resources);
    await prisma.agentJob.update({
      where: { id: "legacy" },
      data: { operationResourcesJson: null },
    });
    const service = new AgentControlService();
    await service.claimJob("agent", "legacy");
    await expect(
      service.completeJob(
        "agent",
        "legacy",
        "FAILED",
        undefined,
        "Agent service restarted while this job was running",
      ),
    ).rejects.toThrow("original agent");
    expect(
      await prisma.operationHolder.count({ where: { state: "HELD" } }),
    ).toBe(1);
    await service.completeJob(
      "agent",
      "legacy",
      "SUCCEEDED",
      { exitCode: 0 },
      null,
    );
    expect(
      await prisma.operationHolder.count({ where: { state: "HELD" } }),
    ).toBe(0);
  });
  test("fails a queued job whose source branch changed instead of granting a stale merge intent", async () => {
    await enqueue("stale-build", "a");
    await prisma.worktree.update({
      where: { id: "a" },
      data: { branch: "feature/replaced" },
    });
    await expect(
      new AgentControlService().claimJob("agent", "stale-build", "stale"),
    ).rejects.toThrow("changed while queued");
    expect(
      await prisma.agentJob.findUniqueOrThrow({ where: { id: "stale-build" } }),
    ).toMatchObject({ status: "FAILED", executionToken: null });
    expect(
      await prisma.operationHolder.count({ where: { state: "HELD" } }),
    ).toBe(0);
  });
  test("runs two sibling builds and a third worktree mutation together", async () => {
    await enqueue("build-a", "a");
    await enqueue("build-b", "b");
    await enqueue("commit-c", "c", "WRITE");
    const service = new AgentControlService();
    const jobs = await Promise.all([
      service.claimJob("agent", "build-a", "token-a"),
      service.claimJob("agent", "build-b", "token-b"),
      service.claimJob("agent", "commit-c", "token-c"),
    ]);
    expect(jobs.map((job) => job.status)).toEqual([
      "RUNNING",
      "RUNNING",
      "RUNNING",
    ]);
    expect(
      await prisma.operationHolder.count({ where: { state: "HELD" } }),
    ).toBe(3);
  });

  test("same-worktree mutation waits while inspection overlaps a build", async () => {
    await enqueue("build", "a");
    const service = new AgentControlService();
    await service.claimJob("agent", "build", "build-token");
    await enqueue("mutate", "a", "WRITE");
    await enqueue("inspect", "a", "READ");
    // Read-only inspections may pass a queued writer during a running build.
    await expect(
      service.claimJob("agent", "mutate", "mutation-token"),
    ).rejects.toBeInstanceOf(ResourceBusyError);
    expect(
      (await prisma.agentJob.findUniqueOrThrow({ where: { id: "mutate" } }))
        .status,
    ).toBe("QUEUED");
    await expect(
      service.claimJob("agent", "inspect", "inspect-token"),
    ).resolves.toMatchObject({ status: "RUNNING" });
    await service.completeJob(
      "agent",
      "build",
      "SUCCEEDED",
      {},
      null,
      "build-token",
    );
    await expect(
      service.claimJob("agent", "mutate", "mutation-token"),
    ).rejects.toBeInstanceOf(ResourceBusyError);
    await service.completeJob(
      "agent",
      "inspect",
      "SUCCEEDED",
      {},
      null,
      "inspect-token",
    );
    await expect(
      service.claimJob("agent", "mutate", "mutation-token"),
    ).resolves.toMatchObject({ status: "RUNNING" });
  });

  test("a queued conflict does not block an independent worktree", async () => {
    await enqueue("first", "a");
    const service = new AgentControlService();
    await service.claimJob("agent", "first", "first");
    await enqueue("waiting", "a");
    await expect(
      service.claimJob("agent", "waiting", "waiting"),
    ).rejects.toBeInstanceOf(ResourceBusyError);
    await enqueue("independent", "b");
    await expect(
      service.claimJob("agent", "independent", "independent"),
    ).resolves.toMatchObject({ status: "RUNNING" });
  });

  test("retains cancellation protection until cleanup acknowledgement and rejects stale tokens", async () => {
    const service = new AgentControlService();
    await enqueue("build", "a");
    await service.claimJob("agent", "build", "owner");
    await expect(
      service.claimJob("agent", "build", "intruder"),
    ).rejects.toBeInstanceOf(ResourceBusyError);
    await expect(service.cancelJob("build")).resolves.toMatchObject({
      status: "CANCELLING",
    });
    await enqueue("next", "a", "WRITE");
    await expect(
      service.claimJob("agent", "next", "next"),
    ).rejects.toBeInstanceOf(ResourceBusyError);
    await expect(
      service.completeJob(
        "agent",
        "build",
        "CANCELLED",
        null,
        null,
        "intruder",
      ),
    ).rejects.toThrow("token");
    await service.completeJob(
      "agent",
      "build",
      "CANCELLED",
      null,
      null,
      "owner",
    );
    await expect(
      service.claimJob("agent", "next", "next"),
    ).resolves.toMatchObject({ status: "RUNNING" });
  });

  test("merge and build admission exclude each other only on the source branch", async () => {
    const service = new AgentControlService();
    await enqueue("build-a", "a");
    await service.claimJob("agent", "build-a", "build-a");
    await expect(
      withMergeReservation(
        "https://github.com/acme/app.git",
        "feature/a",
        async () => "merged",
      ),
    ).rejects.toBeInstanceOf(ResourceBusyError);
    await expect(
      withMergeReservation(
        "github.com/acme/app",
        "feature/b",
        async () => "merged",
      ),
    ).resolves.toBe("merged");
    await service.completeJob(
      "agent",
      "build-a",
      "SUCCEEDED",
      {},
      null,
      "build-a",
    );
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const merge = withMergeReservation(
      "github.com/acme/app",
      "feature/a",
      async () => {
        entered.resolve();
        await finish.promise;
        return "merged";
      },
    );
    await entered.promise;
    try {
      await enqueue("new-build-a", "a");
      await enqueue("new-build-b", "b");
      await expect(
        service.claimJob("agent", "new-build-a", "new-a"),
      ).rejects.toBeInstanceOf(ResourceBusyError);
      await expect(
        service.claimJob("agent", "new-build-b", "new-b"),
      ).resolves.toMatchObject({ status: "RUNNING" });
    } finally {
      finish.resolve();
      await merge;
    }
  });

  test("hierarchical barriers and multi-target claims acquire atomically across connections", async () => {
    const other = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: file }),
    });
    try {
      await enqueue("build-a", "a");
      await new AgentControlService().claimJob("agent", "build-a", "a");
      const batch: OperationDescriptor = {
        version: 1,
        resources: [
          ...descriptor("a", "WRITE").resources,
          ...descriptor("b", "WRITE").resources,
        ],
      };
      await expect(
        other.$transaction((transaction) =>
          admitOperation(transaction, "BATCH", "batch", batch, "batch"),
        ),
      ).rejects.toBeInstanceOf(ResourceBusyError);
      expect(
        await prisma.operationHolder.count({
          where: { ownerKind: "BATCH", state: "HELD" },
        }),
      ).toBe(0);
      await enqueue("build-b", "b");
      await expect(
        new AgentControlService().claimJob("agent", "build-b", "b"),
      ).resolves.toMatchObject({ status: "RUNNING" });
      const barrier: OperationDescriptor = {
        version: 1,
        resources: [
          {
            kind: "CODEBASE",
            key: "agent:codebase:codebase",
            mode: "WRITE",
            agentId: "agent",
            codebaseId: "codebase",
          },
        ],
      };
      await expect(
        other.$transaction((transaction) =>
          admitOperation(transaction, "BARRIER", "barrier", barrier, "barrier"),
        ),
      ).rejects.toBeInstanceOf(ResourceBusyError);
    } finally {
      await other.$disconnect();
    }
  });

  test("move children reuse only declared parent worktrees", async () => {
    await prisma.$transaction((transaction) =>
      admitOperation(
        transaction,
        "WORKTREE_MOVE",
        "move",
        descriptor("a", "WRITE"),
        "move",
      ),
    );
    await enqueue("a-waiting", "a", "WRITE");
    await expect(
      prisma.$transaction((transaction) =>
        admitOperation(
          transaction,
          "AGENT_JOB",
          "child",
          descriptor("a", "WRITE"),
          "child",
          "move",
        ),
      ),
    ).resolves.toMatchObject({ state: "HELD" });
    await expect(
      prisma.$transaction((transaction) =>
        admitOperation(
          transaction,
          "AGENT_JOB",
          "escape",
          descriptor("b", "WRITE"),
          "escape",
          "move",
        ),
      ),
    ).rejects.toThrow("undeclared");
    await releaseOperation("AGENT_JOB", "child", "child");
    await releaseOperation("WORKTREE_MOVE", "move", "move");
  });

  test("recovers an abandoned pre-submission merge without permitting the original caller to submit", async () => {
    const preparing = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const submit = vi.fn();
    const merge = withMergeReservation(
      "github.com/acme/app",
      "feature/a",
      async (reservation) => {
        preparing.resolve();
        await proceed.promise;
        await reservation.markSubmitted();
        submit();
        return "merged";
      },
    );
    const rejected = expect(merge).rejects.toBeInstanceOf(ResourceBusyError);
    await preparing.promise;
    await prisma.operationHolder.updateMany({
      where: { ownerKind: "MERGE_SUBMISSION", state: "HELD" },
      data: { updatedAt: new Date(0) },
    });
    await recoverMergeReservations(
      "github.com/acme/app",
      "feature/a",
      async () => false,
    );
    proceed.resolve();
    await rejected;
    expect(submit).not.toHaveBeenCalled();
    expect(
      await prisma.operationHolder.count({ where: { state: "HELD" } }),
    ).toBe(0);
  });

  test("retains ambiguous submissions until provider recovery confirms their outcome", async () => {
    const context = {
      provider: "GITHUB",
      owner: "acme",
      name: "app",
      number: 7,
    };
    const unknown = Object.assign(new Error("Connection closed during merge"), {
      mergeOutcomeUnknown: true,
      mergeRecovery: context,
    });
    await expect(
      withMergeReservation(
        "github.com/acme/app",
        "feature/a",
        async (reservation) => {
          await reservation.markSubmitted();
          throw unknown;
        },
        context,
      ),
    ).rejects.toBe(unknown);
    const verify = vi.fn().mockResolvedValue(false);
    await recoverMergeReservations("github.com/acme/app", "feature/a", verify);
    expect(verify).toHaveBeenCalledWith(context);
    await enqueue("build-after-unknown", "a");
    await expect(
      new AgentControlService().claimJob(
        "agent",
        "build-after-unknown",
        "build",
      ),
    ).rejects.toBeInstanceOf(ResourceBusyError);
    await recoverMergeReservations(
      "github.com/acme/app",
      "feature/a",
      async () => true,
    );
    await expect(
      new AgentControlService().claimJob(
        "agent",
        "build-after-unknown",
        "build",
      ),
    ).resolves.toMatchObject({ status: "RUNNING" });
  });

  test("confirmed provider success survives bookkeeping failure", async () => {
    const update = vi
      .spyOn(prisma.operationHolder, "update")
      .mockRejectedValueOnce(new Error("Database temporarily unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        withMergeReservation(
          "github.com/acme/app",
          "feature/a",
          async (reservation) => {
            await reservation.markSubmitted();
            return "merged";
          },
        ),
      ).resolves.toBe("merged");
      expect(log).toHaveBeenCalled();
    } finally {
      update.mockRestore();
      log.mockRestore();
    }
  });

  test("retains completion ownership across projection failure for a safe retry", async () => {
    const service = new AgentControlService();
    await enqueue("build", "a");
    await service.claimJob("agent", "build", "build");
    service.registerCompletionHandler(
      "ios.build.run",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("Projection interrupted"))
        .mockResolvedValue(undefined),
    );
    await expect(
      service.completeJob("agent", "build", "SUCCEEDED", {}, null, "build"),
    ).rejects.toThrow("Projection interrupted");
    expect(
      await prisma.operationHolder.count({ where: { state: "HELD" } }),
    ).toBe(1);
    expect(await service.listJobs("agent", 1, true)).toEqual([
      expect.objectContaining({
        id: "build",
        status: "SUCCEEDED",
        executionToken: "build",
      }),
    ]);
    await service.completeJob("agent", "build", "SUCCEEDED", {}, null, "build");
    expect(
      await prisma.operationHolder.count({ where: { state: "HELD" } }),
    ).toBe(0);
    expect(
      (await prisma.agentJob.findUniqueOrThrow({ where: { id: "build" } }))
        .executionToken,
    ).toBeNull();
  });
});
