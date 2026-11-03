// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  IOS_DEPLOY_JOB_KIND,
  IOS_REMOTE_DEPLOY_JOB_KIND,
} from "@ai-development-environment/agent-contract/builds";
import type { AgentControlService } from "@/services/agent-control";
import type { TelemetryService } from "@/services/telemetry";
import { BuildsService } from "./builds.service";

function fixture() {
  const deployments = new Map(
    ["device-1", "device-2"].map((id) => [
      id,
      {
        id,
        buildId: "build-1",
        batchId: "run-1",
        jobId: "job-1",
        transferId: null,
        startedAt: null as Date | null,
        launchedAt: null as Date | null,
        job: { agentId: "target-agent", kind: IOS_REMOTE_DEPLOY_JOB_KIND },
      },
    ]),
  );
  const separators = new Map<
    string,
    { id: string; clientTime: Date; buildId: string }
  >();
  const db = {
    buildDeployment: {
      findUnique: vi.fn(async ({ where }) => deployments.get(where.id) ?? null),
      findMany: vi.fn(async () => [...deployments.values()]),
      update: vi.fn(async ({ where, data }) =>
        Object.assign(deployments.get(where.id)!, data),
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = deployments.get(where.id)!;
        if (!row.launchedAt || row.launchedAt > data.launchedAt)
          row.launchedAt = data.launchedAt;
        return { count: 1 };
      }),
    },
    telemetryEntry: {
      upsert: vi.fn(async ({ where, create }) => {
        if (!separators.has(where.separatorKey))
          separators.set(where.separatorKey, create);
        return separators.get(where.separatorKey)!;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = separators.get(where.separatorKey)!;
        if (row.clientTime > data.clientTime) row.clientTime = data.clientTime;
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (operation) => operation(db)),
  };
  getPrismaClient.mockResolvedValue(db);
  const completion = new Map<string, (job: never) => Promise<unknown>>();
  const control = {
    registerCompletionHandler: (
      kind: string,
      handler: (job: never) => Promise<unknown>,
    ) => completion.set(kind, handler),
  } as unknown as AgentControlService;
  const telemetry = { notifyChange: vi.fn() } as unknown as TelemetryService;
  return {
    service: new BuildsService(control, telemetry),
    db,
    completion,
    deployments,
    separators,
    telemetry,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("successful build launch separators", () => {
  test("keeps one marker per Run action across devices, retries, and completion repair", async () => {
    const { service, separators, deployments, completion } = fixture();
    const first = "2026-11-02T14:00:00.000Z";
    const later = "2026-11-02T14:02:00.000Z";
    await service.reportDeploymentLaunched("target-agent", {
      jobId: "job-1",
      deploymentId: "device-1",
      launchedAt: later,
    });
    await service.reportDeploymentLaunched("target-agent", {
      jobId: "job-1",
      deploymentId: "device-2",
      launchedAt: first,
    });
    await service.reportDeploymentLaunched("target-agent", {
      jobId: "job-1",
      deploymentId: "device-2",
      launchedAt: first,
    });
    await completion.get(IOS_REMOTE_DEPLOY_JOB_KIND)!({
      id: "job-1",
      status: "SUCCEEDED",
      resultJson: JSON.stringify({
        deployments: [
          { id: "device-1", status: "SUCCEEDED", launchedAt: later },
          { id: "device-2", status: "SUCCEEDED", launchedAt: first },
        ],
      }),
      finishedAt: new Date(later),
      error: null,
    } as never);
    expect(separators.size).toBe(1);
    expect(separators.get("build-run:run-1")?.clientTime.toISOString()).toBe(
      first,
    );
    expect(deployments.get("device-2")?.launchedAt?.toISOString()).toBe(first);
    deployments.get("device-1")!.batchId = "run-2";
    await service.reportDeploymentLaunched("target-agent", {
      jobId: "job-1",
      deploymentId: "device-1",
      launchedAt: later,
    });
    expect(separators.size).toBe(2);
  });

  test("checks the deployment job owner, including remote-run targets", async () => {
    const { service, db } = fixture();
    await expect(
      service.reportDeploymentLaunched("build-source-agent", {
        jobId: "job-1",
        deploymentId: "device-1",
        launchedAt: "2026-11-02T14:00:00Z",
      }),
    ).rejects.toThrow("Deployment not found");
    await expect(
      service.reportDeploymentLaunched("target-agent", {
        jobId: "other-job",
        deploymentId: "device-1",
        launchedAt: "2026-11-02T14:00:00Z",
      }),
    ).rejects.toThrow("Deployment not found");
    await expect(
      service.reportDeploymentLaunched("target-agent", {
        jobId: "job-1",
        deploymentId: "device-1",
        launchedAt: "invalid",
      }),
    ).rejects.toThrow("Launch time");
    expect(db.telemetryEntry.upsert).not.toHaveBeenCalled();
  });

  test("repairs older-agent successful results at completion and ignores failed launches", async () => {
    const { completion, separators } = fixture();
    const finishedAt = new Date("2026-11-02T14:02:00Z");
    await completion.get(IOS_DEPLOY_JOB_KIND)!({
      id: "job-1",
      status: "FAILED",
      resultJson: JSON.stringify({
        deployments: [
          { id: "device-1", status: "FAILED" },
          { id: "device-2", status: "SUCCEEDED" },
        ],
      }),
      finishedAt,
      error: "First device unavailable",
    } as never);
    expect(separators.size).toBe(1);
    expect(separators.get("build-run:run-1")?.clientTime).toEqual(finishedAt);
  });
});
