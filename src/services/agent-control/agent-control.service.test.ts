import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { AgentControlService } from "./agent-control.service";

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
