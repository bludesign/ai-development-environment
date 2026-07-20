import { beforeEach, describe, expect, test, vi } from "vitest";

import { IOS_ARTIFACT_DOWNLOAD_JOB_KIND } from "@ai-development-environment/agent-contract/builds";

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

describe("agent job validation", () => {
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
