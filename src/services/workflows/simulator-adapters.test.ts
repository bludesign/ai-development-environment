import { describe, expect, test, vi } from "vitest";

import {
  WorkflowStepExecutor,
  type WorkflowExecutionContext,
} from "./step-executor";
import {
  SIMULATOR_JOBS_WAIT,
  WORKFLOW_RUN_CANCELLED,
  registerSimulatorAdapters,
} from "./simulator-adapters";
import type { WorkflowsService } from "./workflows.service";
import type { SimulatorsService } from "@/services/simulators/simulators.service";

const simulatorId = "01234567-89AB-CDEF-0123-456789ABCDEF";
const secondId = "11234567-89AB-CDEF-0123-456789ABCDEF";

function harness() {
  const executor = new WorkflowStepExecutor();
  const registerWaitPoller = vi.fn<WorkflowsService["registerWaitPoller"]>();
  const getJobs = vi.fn<SimulatorsService["getJobs"]>();
  const enqueue = vi.fn();
  const deleteSelected = vi.fn();
  registerSimulatorAdapters(
    { registerWaitPoller } as unknown as WorkflowsService,
    executor,
    { enqueue, deleteSelected, getJobs } as unknown as SimulatorsService,
  );
  const execute = (
    kind: WorkflowExecutionContext["node"]["kind"],
    config: Record<string, unknown>,
    attempt = "attempt-1",
    signal = new AbortController().signal,
  ) =>
    executor.execute({
      run: { id: "workflow-run" },
      attempt: { id: attempt, generation: 1, iterationKey: null },
      node: { id: "simulator", kind, config },
      signal,
    } as unknown as WorkflowExecutionContext);
  const [waitKind, poller] = registerWaitPoller.mock.calls[0]!;
  return { execute, waitKind, poller, enqueue, getJobs, deleteSelected };
}

function job(
  jobId: string,
  agentId: string,
  status: string,
  error: string | null = null,
): Awaited<ReturnType<SimulatorsService["getJob"]>> {
  return {
    jobId,
    agentId,
    operation: "DELETE",
    status,
    error,
    timeoutSeconds: 120,
    simulatorId,
    bundleId: null,
    inventory: null,
    details: null,
  };
}

describe("simulator workflow steps", () => {
  test("uses one submission key across retries and awaits typed results", async () => {
    const { execute, waitKind, poller, enqueue, getJobs } = harness();
    enqueue.mockResolvedValue({
      id: "create-job",
      agentId: "mac",
      status: "QUEUED",
      error: null,
      timeoutSeconds: 120,
    });
    const config = {
      agentId: "mac",
      name: "Apple TV",
      runtimeId: "com.apple.CoreSimulator.SimRuntime.tvOS-26-5",
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.Apple-TV",
    };
    const startedAt = Date.now();
    const initial = await execute("SIMULATOR_CREATE", config);
    expect(initial.wait?.timeoutAt?.getTime()).toBeGreaterThanOrEqual(
      startedAt + 120_000,
    );
    expect(initial.wait?.timeoutAt?.getTime()).toBeLessThanOrEqual(
      Date.now() + 120_000,
    );
    const retried = await execute("SIMULATOR_CREATE", config, "attempt-2");
    expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[1]);
    expect(enqueue).toHaveBeenCalledWith(
      "mac",
      expect.any(String),
      "simulators.create",
      {
        name: config.name,
        runtimeId: config.runtimeId,
        deviceTypeId: config.deviceTypeId,
      },
      { source: "WORKFLOW" },
    );
    expect(waitKind).toBe(SIMULATOR_JOBS_WAIT);
    expect(initial.wait?.externalKey).toBe(retried.wait?.externalKey);
    getJobs.mockResolvedValue([
      {
        ...job("create-job", "mac", "SUCCEEDED"),
        operation: "CREATE",
      },
    ]);
    await expect(
      poller(initial.wait!.externalKey!, false),
    ).resolves.toMatchObject({
      pending: false,
      error: null,
      result: { simulatorId, jobId: "create-job", operation: "CREATE" },
    });
  });

  test("waits for every accepted deletion and retains admission and terminal errors", async () => {
    const { execute, poller, getJobs, deleteSelected } = harness();
    const targets = [
      { agentId: "mac-1", simulatorId },
      { agentId: "mac-2", simulatorId: secondId },
      { agentId: "offline-mac", simulatorId },
    ];
    deleteSelected.mockResolvedValue({
      targets: [
        { ...targets[0], jobId: "success", status: "QUEUED", error: null },
        { ...targets[1], jobId: "cancelled", status: "QUEUED", error: null },
        { ...targets[2], jobId: null, status: null, error: "Agent is offline" },
      ],
    });
    const startedAt = Date.now();
    const { wait } = await execute("SIMULATOR_DELETE", {
      targets,
      confirm: true,
    });
    expect(wait?.timeoutAt?.getTime()).toBeGreaterThanOrEqual(
      startedAt + 3_600_000,
    );
    expect(wait?.timeoutAt?.getTime()).toBeLessThanOrEqual(
      Date.now() + 3_600_000,
    );
    getJobs.mockResolvedValueOnce([
      job("success", "mac-1", "SUCCEEDED"),
      job("cancelled", "mac-2", "CANCELLING"),
    ]);
    await expect(poller(wait!.externalKey!, false)).resolves.toEqual({
      pending: true,
      pollAfterSeconds: 2,
    });
    expect(getJobs).toHaveBeenCalledExactlyOnceWith([
      { agentId: "mac-1", jobId: "success" },
      { agentId: "mac-2", jobId: "cancelled" },
    ]);
    getJobs.mockResolvedValueOnce([
      job("success", "mac-1", "SUCCEEDED"),
      job("cancelled", "mac-2", "CANCELLED", "Cancelled"),
    ]);
    await expect(poller(wait!.externalKey!, false)).resolves.toEqual({
      pending: false,
      error: "2 of 3 simulator deletions failed",
      result: {
        targets: [
          { ...targets[0], jobId: "success", status: "SUCCEEDED", error: null },
          {
            ...targets[1],
            jobId: "cancelled",
            status: "CANCELLED",
            error: "Cancelled",
          },
          {
            ...targets[2],
            jobId: null,
            status: "FAILED",
            error: "Agent is offline",
          },
        ],
      },
    });
  });

  test("keeps observed results when a configured workflow deadline expires", async () => {
    const { execute, poller, getJobs, enqueue } = harness();
    enqueue.mockResolvedValue({
      id: "reset",
      agentId: "mac",
      status: "QUEUED",
      error: null,
      timeoutSeconds: 600,
    });
    const startedAt = Date.now();
    const { wait } = await execute("SIMULATOR_RESET", {
      agentId: "mac",
      confirm: true,
      timeoutSeconds: 90,
    });
    expect(wait?.timeoutAt?.getTime()).toBeGreaterThanOrEqual(
      startedAt + 90_000,
    );
    expect(wait?.timeoutAt?.getTime()).toBeLessThanOrEqual(Date.now() + 90_000);
    getJobs.mockResolvedValue([
      {
        ...job("reset", "mac", "RUNNING"),
        operation: "RESET",
        simulatorId: null,
      },
    ]);
    await expect(poller(wait!.externalKey!, true)).resolves.toMatchObject({
      pending: false,
      error: "Workflow wait for simulator jobs timed out",
      result: { jobId: "reset", status: "RUNNING" },
    });
  });

  test("stops bulk submission on workflow cancellation and keeps accepted jobs linked", async () => {
    const { execute, deleteSelected } = harness();
    const controller = new AbortController();
    const target = { agentId: "mac", simulatorId };
    deleteSelected.mockImplementationOnce(
      async (_targets, _requestId, _source, shouldStopSubmitting) => {
        expect(shouldStopSubmitting()).toBe(false);
        controller.abort(WORKFLOW_RUN_CANCELLED);
        expect(shouldStopSubmitting()).toBe(true);
        return {
          targets: [
            { ...target, jobId: "accepted", status: "QUEUED", error: null },
          ],
        };
      },
    );

    const result = await execute(
      "SIMULATOR_DELETE",
      {
        targets: [target, { agentId: "mac", simulatorId: secondId }],
        confirm: true,
      },
      "attempt-1",
      controller.signal,
    );

    expect(result.links).toEqual([
      expect.objectContaining({ kind: "AGENT_JOB", resourceId: "accepted" }),
    ]);
  });

  test("requires explicit confirmation before submitting destructive jobs", async () => {
    const { execute, enqueue, deleteSelected } = harness();
    expect(() =>
      execute("SIMULATOR_DEVICE_ACTION", {
        agentId: "mac",
        simulatorId,
        action: "ERASE",
      }),
    ).toThrow("requires confirmation");
    await expect(execute("SIMULATOR_DELETE", { targets: [] })).rejects.toThrow(
      "requires confirmation",
    );
    expect(() => execute("SIMULATOR_RESET", { agentId: "mac" })).toThrow(
      "requires confirmation",
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(deleteSelected).not.toHaveBeenCalled();
  });
});
