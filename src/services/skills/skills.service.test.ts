import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import type { AgentControlService } from "@/services/agent-control";

import { SkillsService } from "./skills.service";

function serviceWith(cancelJob = vi.fn()) {
  const agentControl = {
    cancelJob,
    registerCompletionHandler: vi.fn(),
    registerConnectionHandler: vi.fn(),
  } as unknown as AgentControlService;
  return { cancelJob, service: new SkillsService(agentControl) };
}

describe("SkillsService.skipPending", () => {
  beforeEach(() => vi.clearAllMocks());

  test("skips a pending scan, cancels its job, and continues planning", async () => {
    const pendingScan = {
      id: "scan-item-1",
      runId: "run-1",
      agentId: "agent-1",
      direction: "SCAN",
      status: "PENDING",
      candidatePackageJson: null,
    };
    const persistedRun = { id: "run-1", status: "READY" };
    const prisma = {
      agentJob: {
        findUnique: vi.fn().mockResolvedValue({ id: "scan-job-1" }),
      },
      skillSyncItem: {
        findMany: vi.fn().mockResolvedValue([pendingScan]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      skillSyncRun: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(persistedRun),
        findUnique: vi.fn().mockResolvedValue(persistedRun),
      },
      skillDeployment: { updateMany: vi.fn() },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const { cancelJob, service } = serviceWith();
    const buildPlan = vi
      .spyOn(
        service as unknown as { buildPlan(runId: string): Promise<void> },
        "buildPlan",
      )
      .mockResolvedValue();

    await expect(service.skipPending("run-1")).resolves.toBe(persistedRun);

    expect(prisma.skillSyncItem.updateMany).toHaveBeenCalledWith({
      where: { id: "scan-item-1", status: "PENDING" },
      data: { status: "SKIPPED", resolution: "SKIP" },
    });
    expect(prisma.agentJob.findUnique).toHaveBeenCalledWith({
      where: {
        agentId_idempotencyKey: {
          agentId: "agent-1",
          idempotencyKey: "skills:scan:run-1:agent-1",
        },
      },
    });
    expect(cancelJob).toHaveBeenCalledWith("scan-job-1");
    expect(buildPlan).toHaveBeenCalledWith("run-1");
  });

  test("marks a sync partial when its last pending apply is skipped", async () => {
    const pendingApply = {
      id: "apply-item-1",
      runId: "run-1",
      agentId: "agent-1",
      direction: "APPLY",
      status: "PENDING",
      candidatePackageJson: JSON.stringify({
        deployments: [{ id: "deployment-1" }],
      }),
    };
    const persistedRun = { id: "run-1", status: "PARTIAL" };
    const prisma = {
      agentJob: {
        findUnique: vi.fn().mockResolvedValue({ id: "apply-job-1" }),
      },
      skillSyncItem: {
        findMany: vi.fn().mockResolvedValue([pendingApply]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      skillSyncRun: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(persistedRun),
        findUnique: vi.fn().mockResolvedValue(persistedRun),
        update: vi.fn().mockResolvedValue(persistedRun),
      },
      skillDeployment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const { cancelJob, service } = serviceWith();

    await expect(service.skipPending("run-1")).resolves.toBe(persistedRun);

    expect(cancelJob).toHaveBeenCalledWith("apply-job-1");
    expect(prisma.skillDeployment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["deployment-1"] }, status: "PENDING" },
      data: { status: "SKIPPED" },
    });
    expect(prisma.skillSyncRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: { status: "PARTIAL", finishedAt: expect.any(Date) },
    });
  });
});
