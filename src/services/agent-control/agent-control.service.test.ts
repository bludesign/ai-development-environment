import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  AgentControlService,
  SUPPORTED_AGENT_JOBS,
  validateJob,
} from "./agent-control.service";

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
