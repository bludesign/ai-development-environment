import { beforeEach, describe, expect, test, vi } from "vitest";

import { IOS_ARTIFACT_DOWNLOAD_JOB_KIND } from "@ai-development-environment/agent-contract/builds";
import { CODEBASE_BRANCHES_DELETE_JOB_KIND } from "@ai-development-environment/agent-contract/codebases";

import { CodebaseBusyError } from "@/lib/codebase-busy";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  AgentControlService,
  SUPPORTED_AGENT_JOBS,
  validateJob,
} from "./agent-control.service";
import { agentEventBus, agentEventsTopic } from "./event-bus";

function persistedJob(status: string, resultJson: string | null = null) {
  return {
    id: "job-1",
    agentId: "agent-1",
    status,
    resultJson,
  };
}

describe("AgentControlService branch deletion progress", () => {
  beforeEach(() => vi.clearAllMocks());
  test("publishes durable outcomes only for the owning agent and selected local targets, without replacing replays", async () => {
    let job = {
      ...persistedJob("RUNNING"),
      kind: CODEBASE_BRANCHES_DELETE_JOB_KIND,
      payloadJson: JSON.stringify({
        codebaseId: "checkout",
        folder: "/repo",
        expectedOrigin: "example.com/app",
        defaultBranch: "main",
        force: false,
        targets: [
          {
            codebaseId: "checkout",
            branch: "old",
            expectedHeadSha: "a".repeat(40),
          },
        ],
      }),
    };
    const update = vi.fn(async ({ data }) => {
      job = { ...job, ...data };
      return job;
    });
    const transaction = {
      agentJob: { findUnique: vi.fn(async () => job), update },
    };
    getPrismaClient.mockResolvedValue({
      $transaction: async (body: (value: typeof transaction) => unknown) =>
        body(transaction),
    });
    const service = new AgentControlService();
    const result = {
      codebaseId: "checkout",
      branch: "old",
      outcome: "DELETED" as const,
      reason: null,
    };
    await expect(
      service.reportBranchDeletionResult("other-agent", job.id, result),
    ).rejects.toThrow("not found for this agent");
    await expect(
      service.reportBranchDeletionResult(job.agentId, job.id, {
        ...result,
        branch: "unselected",
      }),
    ).rejects.toThrow("not a target");
    await service.reportBranchDeletionResult(job.agentId, job.id, result);
    await service.reportBranchDeletionResult(job.agentId, job.id, result);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0].where).toEqual({
      id: job.id,
      status: "RUNNING",
    });
    expect(JSON.parse(job.resultJson!)).toEqual({
      branchDeletionResults: [result],
    });
  });
  test("retains known deleted outcomes when a cleanup job fails without its final payload", async () => {
    const partial = JSON.stringify({
      branchDeletionResults: [
        {
          codebaseId: "checkout",
          branch: "old",
          outcome: "DELETED",
          reason: null,
        },
      ],
    });
    const job = {
      ...persistedJob("RUNNING", partial),
      kind: CODEBASE_BRANCHES_DELETE_JOB_KIND,
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      agentJob: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(job)
          .mockResolvedValueOnce({ ...job, status: "FAILED" }),
        updateMany,
      },
    });
    await new AgentControlService().completeJob(
      job.agentId,
      job.id,
      "FAILED",
      null,
      "Connection lost",
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resultJson: partial }),
      }),
    );
  });
});

describe("AgentControlService.completeJob", () => {
  beforeEach(() => vi.clearAllMocks());

  test("preserves the first terminal status and result on duplicate completion", async () => {
    const succeeded = persistedJob("SUCCEEDED", '{"exitCode":0}');
    const prisma = {
      agentJob: {
        findUnique: vi.fn().mockResolvedValue(succeeded),
        updateMany: vi.fn(),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);

    const result = await new AgentControlService().completeJob(
      "agent-1",
      "job-1",
      "FAILED",
      null,
      "late failure",
    );

    expect(result).toBe(succeeded);
    expect(prisma.agentJob.updateMany).not.toHaveBeenCalled();
  });

  test("preserves a terminal state won by a concurrent cancellation", async () => {
    const running = persistedJob("RUNNING");
    const cancelled = persistedJob("CANCELLED");
    const prisma = {
      agentJob: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(running)
          .mockResolvedValueOnce(cancelled),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);

    const result = await new AgentControlService().completeJob(
      "agent-1",
      "job-1",
      "SUCCEEDED",
      { exitCode: 0 },
      null,
    );

    expect(result).toBe(cancelled);
  });
});

describe("AgentControlService.claimJob", () => {
  beforeEach(() => vi.clearAllMocks());

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
      agentJob: {
        findUnique: vi.fn().mockResolvedValue({
          agentId: "agent-1",
          status: "QUEUED",
          worktreeId: "worktree-1",
          kind: "ios.build.run",
        }),
      },
    });

    await expect(
      new AgentControlService().claimJob("agent-1", "build-1"),
    ).rejects.toThrow("cleanup is in progress");
    expect(deleteMany).toHaveBeenCalledWith({
      where: { jobId: null, expiresAt: { lte: expect.any(Date) } },
    });
  });
});

describe("AgentControlService.createJob", () => {
  beforeEach(() => vi.clearAllMocks());

  test("requires cleanup jobs to use registered agent, folder, origin, and default branch", async () => {
    const payload = {
      codebaseId: "checkout",
      folder: "/registered",
      expectedOrigin: "example.com/app",
      defaultBranch: "main",
      force: true,
      targets: [
        {
          codebaseId: "checkout",
          branch: "old",
          expectedHeadSha: "a".repeat(40),
        },
      ],
    };
    const input = {
      agentId: "agent",
      codebaseId: "checkout",
      kind: CODEBASE_BRANCHES_DELETE_JOB_KIND,
      payload,
      idempotencyKey: "request",
    };
    const existing = { id: "job" };
    getPrismaClient.mockResolvedValue({
      codebase: {
        findUnique: vi.fn().mockResolvedValue({
          id: "checkout",
          agentId: "agent",
          folder: "/registered",
          defaultBranch: "main",
          repository: { canonicalOrigin: "example.com/app" },
        }),
      },
      agentJob: { findUnique: vi.fn().mockResolvedValue(existing) },
    });
    const service = new AgentControlService();
    await expect(
      service.createJob({ ...input, codebaseId: null }),
    ).rejects.toThrow("must use deleteCodebaseBranches");
    await expect(
      service.createJob({ ...input, agentId: "other" }),
    ).rejects.toThrow("not found for this agent");
    for (const field of ["folder", "expectedOrigin", "defaultBranch"]) {
      await expect(
        service.createJob({
          ...input,
          payload: { ...payload, [field]: "other" },
        }),
      ).rejects.toThrow("no longer matches the registered codebase");
    }
    await expect(service.createJob(input)).resolves.toBe(existing);
  });

  const gitInspect = {
    agentId: "agent-1",
    codebaseId: "codebase-1",
    kind: "codebase.git.inspect",
    payload: {
      action: "STATE",
      codebaseId: "codebase-1",
      folder: "/repo",
      expectedOrigin: "github.com/openai/codex",
    },
    idempotencyKey: "codebase:git:state:request-1:codebase-1",
  };

  test("reports a busy codebase instead of leaking the unique violation", async () => {
    // AgentJob_codebaseId_active_key keeps one non-iOS job active per codebase.
    // Tripping it used to escape as a raw Prisma P2002, which reached the UI as
    // an "Invalid prisma.agentJob.create() invocation" stack trace.
    const conflict = Object.assign(
      new Error("Unique constraint failed on the fields: (`codebaseId`)"),
      { code: "P2002", meta: { target: ["codebaseId"] } },
    );
    getPrismaClient.mockResolvedValue({
      agentJob: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(conflict),
      },
    });

    await expect(
      new AgentControlService().createJob(gitInspect),
    ).rejects.toThrow(CodebaseBusyError);
  });

  test("still rethrows unrelated create failures", async () => {
    const failure = new Error("database is locked");
    getPrismaClient.mockResolvedValue({
      agentJob: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(failure),
      },
    });

    await expect(
      new AgentControlService().createJob(gitInspect),
    ).rejects.toThrow("database is locked");
  });

  test("returns the winner of an idempotency race rather than a busy error", async () => {
    const winner = { id: "job-1", ccusageCollectionId: null };
    const conflict = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["agentId", "idempotencyKey"] },
    });
    getPrismaClient.mockResolvedValue({
      agentJob: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(winner),
        create: vi.fn().mockRejectedValue(conflict),
      },
    });

    await expect(new AgentControlService().createJob(gitInspect)).resolves.toBe(
      winner,
    );
  });
});

describe("agent job validation", () => {
  test("validates coverage import payloads", () => {
    expect(SUPPORTED_AGENT_JOBS).toContain("coverage.import");
    expect(() =>
      validateJob("coverage.import", {
        buildId: "build-1",
        codebaseId: "codebase-1",
        worktreeId: "worktree-1",
        folder: "/tmp/worktree-1",
        reportPath: "coverage/lcov.info",
        format: "LCOV",
        baseBranch: "main",
      }),
    ).not.toThrow();
    expect(() =>
      validateJob("coverage.import", {
        buildId: "build-1",
        codebaseId: "codebase-1",
        worktreeId: "worktree-1",
        folder: "/tmp/worktree-1",
        reportPath: "../lcov.info",
        format: "LCOV",
        baseBranch: "main",
      }),
    ).toThrow("reportPath must stay inside the worktree");
  });

  test("validates iOS artifact download payloads", () => {
    expect(SUPPORTED_AGENT_JOBS).toContain(IOS_ARTIFACT_DOWNLOAD_JOB_KIND);
    expect(() =>
      validateJob(IOS_ARTIFACT_DOWNLOAD_JOB_KIND, {
        buildId: "build-1",
        artifactDirectory: "/tmp/build-1",
        artifactRelativePath: "products/App.app",
        uploadId: "upload-1",
        codebaseId: "codebase-1",
      }),
    ).not.toThrow();
    expect(() =>
      validateJob(IOS_ARTIFACT_DOWNLOAD_JOB_KIND, {
        buildId: "build-1",
        artifactDirectory: "/tmp/build-1",
        artifactRelativePath: "../App.app",
        uploadId: "upload-1",
        codebaseId: "codebase-1",
      }),
    ).toThrow("must stay within the worktree");
  });

  test("accepts only an empty ccusage report payload", () => {
    expect(SUPPORTED_AGENT_JOBS).toContain("ccusage.report");
    expect(() => validateJob("ccusage.report", {})).not.toThrow();
    expect(() =>
      validateJob("ccusage.report", { since: "2026-01-01" }),
    ).toThrow("Unexpected ccusage.report payload field");
    expect(() => validateJob("ccusage.report", [])).toThrow(
      "payload must be an object",
    );
  });

  test("validates all Build Data job payloads", () => {
    expect(SUPPORTED_AGENT_JOBS).toEqual(
      expect.arrayContaining([
        "buildData.scan",
        "buildData.size",
        "buildData.delete",
      ]),
    );
    expect(() =>
      validateJob("buildData.scan", {
        mode: "DEFAULT",
        path: null,
        worktrees: [],
      }),
    ).not.toThrow();
    expect(() =>
      validateJob("buildData.size", {
        targets: [{ rootPath: "/DerivedData", path: "/DerivedData/App" }],
      }),
    ).not.toThrow();
    expect(() =>
      validateJob("buildData.delete", { targets: [{ path: "/tmp/App" }] }),
    ).toThrow("rootPath");
    expect(() =>
      validateJob("buildData.delete", {
        source: "AUTOMATIC",
        targets: [
          {
            path: "/DerivedData/App",
            rootPath: "/DerivedData",
            name: "App",
            kind: "PROJECT",
            worktreeId: "worktree-1",
            worktreePath: "/worktrees/App",
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("AgentControlService.requestCodebaseReconcile", () => {
  test("publishes reconcile requests only to upgraded agents", async () => {
    getPrismaClient.mockResolvedValue({
      agent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "agent-1",
            capabilitiesJson: '["codebase.reconcile.requested"]',
          },
          { id: "agent-2", capabilitiesJson: '["codebase.refresh"]' },
        ]),
      },
    });
    const publish = vi.spyOn(agentEventBus, "publish");

    const requested = await new AgentControlService().requestCodebaseReconcile([
      "agent-1",
      "agent-1",
      "agent-2",
    ]);

    expect(requested).toBe(1);
    expect(publish).toHaveBeenCalledWith(agentEventsTopic("agent-1"), {
      agentEvents: { type: "CODEBASE_RECONCILE_REQUESTED", job: null },
    });
    expect(publish).not.toHaveBeenCalledWith(
      agentEventsTopic("agent-2"),
      expect.anything(),
    );
    publish.mockRestore();
  });
});

describe("AgentControlService cadence settings", () => {
  test("uses global scan and fetch defaults until an agent is customized", async () => {
    getPrismaClient.mockResolvedValue({
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "agent-1",
          codebaseScanIntervalSeconds: null,
          jobReconciliationIntervalSeconds: null,
          gitFetchIntervalSeconds: null,
          heartbeatIntervalSeconds: null,
        }),
      },
      codebaseSettings: {
        findUnique: vi.fn().mockResolvedValue({
          refreshIntervalSeconds: 90,
          fetchIntervalSeconds: 600,
        }),
      },
    });

    await expect(
      new AgentControlService().cadenceSettings("agent-1"),
    ).resolves.toEqual({
      agentId: "agent-1",
      codebaseScanIntervalSeconds: 90,
      jobReconciliationIntervalSeconds: 15,
      gitFetchIntervalSeconds: 600,
      heartbeatIntervalSeconds: 15,
    });
  });

  test("validates, saves, and pushes cadence changes to the agent", async () => {
    const settings = {
      codebaseScanIntervalSeconds: 60,
      jobReconciliationIntervalSeconds: 30,
      gitFetchIntervalSeconds: 900,
      heartbeatIntervalSeconds: 20,
    };
    const agent = { id: "agent-1", ...settings };
    const update = vi.fn().mockResolvedValue(agent);
    getPrismaClient.mockResolvedValue({
      agent: {
        update,
        findUnique: vi.fn().mockResolvedValue(agent),
      },
      codebaseSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    const publish = vi.spyOn(agentEventBus, "publish");

    await expect(
      new AgentControlService().updateCadenceSettings("agent-1", settings),
    ).resolves.toEqual({ agentId: "agent-1", ...settings });
    expect(update).toHaveBeenCalledWith({
      where: { id: "agent-1" },
      data: settings,
    });
    expect(publish).toHaveBeenCalledWith(agentEventsTopic("agent-1"), {
      agentEvents: { type: "AGENT_CONFIGURATION_CHANGED", job: null },
    });
    publish.mockRestore();
  });

  test("rejects cadence values outside their operation limits", async () => {
    await expect(
      new AgentControlService().updateCadenceSettings("agent-1", {
        codebaseScanIntervalSeconds: 9,
        jobReconciliationIntervalSeconds: 15,
        gitFetchIntervalSeconds: 300,
        heartbeatIntervalSeconds: 15,
      }),
    ).rejects.toThrow(
      "Codebase scan interval must be an integer from 10 to 3600 seconds",
    );
  });
});

describe("AgentControlService.updateBaseRepoDirectory", () => {
  test("stores an absolute repository directory and supports clearing it", async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({
        id: "agent-1",
        baseRepoDirectory: "/Users/test/Repositories",
      })
      .mockResolvedValueOnce({ id: "agent-1", baseRepoDirectory: null });
    getPrismaClient.mockResolvedValue({ agent: { update } });
    const service = new AgentControlService();

    await service.updateBaseRepoDirectory(
      "agent-1",
      "/Users/test/Repositories",
    );
    await service.updateBaseRepoDirectory("agent-1", null);

    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: "agent-1" },
      data: { baseRepoDirectory: "/Users/test/Repositories" },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: "agent-1" },
      data: { baseRepoDirectory: null },
    });
  });

  test("rejects a relative repository directory", async () => {
    await expect(
      new AgentControlService().updateBaseRepoDirectory(
        "agent-1",
        "Repositories",
      ),
    ).rejects.toThrow("must be an absolute path");
  });
});

describe("AgentControlService.renameAgent", () => {
  test("trims the new name before storing it", async () => {
    const update = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "agent-1", ...data }));
    getPrismaClient.mockResolvedValue({
      agent: {
        findUnique: vi.fn().mockResolvedValue({ id: "agent-1" }),
        update,
      },
    });

    const agent = await new AgentControlService().renameAgent(
      "agent-1",
      "  Studio Mac  ",
    );

    expect(agent.name).toBe("Studio Mac");
    expect(update).toHaveBeenCalledWith({
      where: { id: "agent-1" },
      data: { name: "Studio Mac" },
    });
  });

  test("rejects a blank or oversized name without touching the record", async () => {
    const update = vi.fn();
    getPrismaClient.mockResolvedValue({
      agent: {
        findUnique: vi.fn().mockResolvedValue({ id: "agent-1" }),
        update,
      },
    });
    const service = new AgentControlService();

    await expect(service.renameAgent("agent-1", "   ")).rejects.toThrow(
      "between 1 and 200 characters",
    );
    await expect(
      service.renameAgent("agent-1", "a".repeat(201)),
    ).rejects.toThrow("between 1 and 200 characters");
    expect(update).not.toHaveBeenCalled();
  });

  test("reports a missing agent rather than leaking a database error", async () => {
    const update = vi.fn();
    getPrismaClient.mockResolvedValue({
      agent: { findUnique: vi.fn().mockResolvedValue(null), update },
    });

    await expect(
      new AgentControlService().renameAgent("agent-gone", "Studio Mac"),
    ).rejects.toThrow("Agent not found");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("AgentControlService.deleteAgent", () => {
  test("deletes an existing agent and reports success", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: "agent-1" });
    const del = vi.fn().mockResolvedValue({ id: "agent-1" });
    getPrismaClient.mockResolvedValue({ agent: { findUnique, delete: del } });

    const result = await new AgentControlService().deleteAgent("agent-1");

    expect(result).toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "agent-1" } });
  });

  test("returns false and does not delete when the agent is missing", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const del = vi.fn();
    getPrismaClient.mockResolvedValue({ agent: { findUnique, delete: del } });

    const result = await new AgentControlService().deleteAgent("agent-1");

    expect(result).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });
});

describe("AgentControlService.updateDerivedDataSettings", () => {
  test("stores default, absolute, and relative settings with strict path validation", async () => {
    const update = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "agent-1", ...data }));
    getPrismaClient.mockResolvedValue({ agent: { update } });
    const service = new AgentControlService();

    await service.updateDerivedDataSettings("agent-1", "DEFAULT", null);
    await service.updateDerivedDataSettings(
      "agent-1",
      "ABSOLUTE",
      "/Users/test/DerivedData",
    );
    await service.updateDerivedDataSettings(
      "agent-1",
      "RELATIVE",
      "DerivedData",
    );

    expect(update).toHaveBeenNthCalledWith(3, {
      where: { id: "agent-1" },
      data: {
        derivedDataLocationMode: "RELATIVE",
        derivedDataPath: "DerivedData",
      },
    });
    await expect(
      service.updateDerivedDataSettings(
        "agent-1",
        "RELATIVE",
        "../DerivedData",
      ),
    ).rejects.toThrow("stay within each worktree");
    await expect(
      service.updateDerivedDataSettings("agent-1", "ABSOLUTE", "DerivedData"),
    ).rejects.toThrow("absolute path");
  });
});

describe("validateJob covers every advertised job kind", () => {
  // SUPPORTED_AGENT_JOBS is derived from the contract, but validateJob is a
  // hand-maintained chain. Adding a job kind without a matching branch here
  // dispatches fine from the agent's side and then fails at the control plane
  // with "Unsupported agent job kind", so the two must be checked together.
  test.each([...SUPPORTED_AGENT_JOBS])("%s is recognised", (kind) => {
    try {
      validateJob(kind, {});
    } catch (error) {
      // A payload complaint is expected for an empty payload; only an unknown
      // kind indicates a missing branch.
      expect(String(error)).not.toContain("Unsupported agent job kind");
    }
  });
});

describe("signing inspection payload", () => {
  test("accepts the payload the builds service dispatches", () => {
    expect(() =>
      validateJob("ios.signing.inspect", {
        buildId: "build-1",
        codebaseId: "codebase-1",
        artifactDirectory: "/Users/example/Builds/build-1",
        archiveRelativePath: "archive.xcarchive",
      }),
    ).not.toThrow();
  });

  test("rejects an archive path that escapes the build folder", () => {
    expect(() =>
      validateJob("ios.signing.inspect", {
        buildId: "build-1",
        codebaseId: "codebase-1",
        artifactDirectory: "/Users/example/Builds/build-1",
        archiveRelativePath: "../../etc/passwd",
      }),
    ).toThrow();
  });
});
