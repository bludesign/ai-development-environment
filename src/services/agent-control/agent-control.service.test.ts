import { beforeEach, describe, expect, test, vi } from "vitest";

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
