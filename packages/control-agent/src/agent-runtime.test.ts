import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  heartbeat: vi.fn(),
  pendingJobs: vi.fn(),
  completeJob: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(),
  cancelAll: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  dispose: vi.fn(),
  codebaseReconcile: vi.fn(),
  codebaseIntervalMs: 30_000,
}));

vi.mock("./graphql-client.js", () => ({
  AgentGraphQLClient: class {
    heartbeat(...args: unknown[]) {
      return mocks.heartbeat(...args);
    }
    pendingJobs(...args: unknown[]) {
      return mocks.pendingJobs(...args);
    }
    completeJob(...args: unknown[]) {
      return mocks.completeJob(...args);
    }
  },
  createAgentSubscriptionClient: () => ({ dispose: mocks.dispose }),
  subscribeToAgentEvents: (...args: unknown[]) => {
    mocks.subscribe(...args);
    return mocks.unsubscribe;
  },
}));

vi.mock("./job-executor.js", () => ({
  JobExecutor: class {
    execute(...args: unknown[]) {
      mocks.execute(...args);
    }
    cancel(...args: unknown[]) {
      mocks.cancel(...args);
    }
    cancelAll(...args: unknown[]) {
      return mocks.cancelAll(...args);
    }
  },
}));

vi.mock("./codebase-monitor.js", () => ({
  CodebaseMonitor: class {
    get reconcileIntervalMs() {
      return mocks.codebaseIntervalMs;
    }
    reconcile(...args: unknown[]) {
      return mocks.codebaseReconcile(...args);
    }
  },
}));

vi.mock("./inventory.js", () => ({
  collectInventory: () => ({
    hostname: "test.local",
    version: "test",
    osVersion: "macOS test",
    architecture: "arm64",
    cpuModel: "M4 Pro",
    memoryTotalBytes: 24 * 1024 ** 3,
    memoryFreeBytes: 12 * 1024 ** 3,
    diskTotalBytes: 512 * 1024 ** 3,
    diskFreeBytes: 256 * 1024 ** 3,
    capabilities: ["cloudflared.runTunnel"],
  }),
}));

import type { AgentConfig } from "./config.js";
import { runAgent } from "./agent-runtime.js";

const config: AgentConfig = {
  server: "http://control.test",
  websocketServer: "ws://control.test/graphql",
  agentId: "agent-1",
  credential: "credential",
  name: "test",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.heartbeat.mockResolvedValue({});
  mocks.pendingJobs.mockResolvedValue([]);
  mocks.completeJob.mockResolvedValue({});
  mocks.cancelAll.mockResolvedValue(undefined);
  mocks.dispose.mockResolvedValue(undefined);
  mocks.codebaseReconcile.mockResolvedValue(undefined);
  mocks.codebaseIntervalMs = 30_000;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.useRealTimers());

describe("runAgent startup reconciliation", () => {
  test("stays running when the initial durable-job query fails", async () => {
    mocks.pendingJobs.mockRejectedValueOnce(
      new Error("control plane starting"),
    );
    const controller = new AbortController();
    const running = runAgent(config, controller.signal);

    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    controller.abort();
    await expect(running).resolves.toBeUndefined();
  });

  test("continues queued jobs when one interrupted completion fails", async () => {
    const runningJob = { id: "running", status: "RUNNING" };
    const queuedJob = { id: "queued", status: "QUEUED" };
    mocks.pendingJobs.mockResolvedValueOnce([runningJob, queuedJob]);
    mocks.completeJob.mockRejectedValueOnce(new Error("temporary failure"));
    const controller = new AbortController();
    const running = runAgent(config, controller.signal);

    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    expect(mocks.completeJob).toHaveBeenCalledWith(
      "running",
      "FAILED",
      undefined,
      "Agent service restarted while this job was running",
    );
    expect(mocks.execute).toHaveBeenCalledWith(queuedJob);

    controller.abort();
    await expect(running).resolves.toBeUndefined();
  });

  test("uses the configured delay after each completed codebase scan", async () => {
    vi.useFakeTimers();
    mocks.codebaseIntervalMs = 120_000;
    const controller = new AbortController();
    const running = runAgent(config, controller.signal);

    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(mocks.codebaseReconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(mocks.codebaseReconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.codebaseReconcile).toHaveBeenCalledTimes(2);

    controller.abort();
    await expect(running).resolves.toBeUndefined();
  });

  test("reconciles immediately when the control plane requests it", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const running = runAgent(config, controller.signal);

    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(mocks.codebaseReconcile).toHaveBeenCalledTimes(1);
    const onEvent = mocks.subscribe.mock.calls[0]?.[2] as (event: {
      type: string;
      job: null;
    }) => void;
    onEvent({ type: "CODEBASE_RECONCILE_REQUESTED", job: null });
    await vi.waitFor(() =>
      expect(mocks.codebaseReconcile).toHaveBeenCalledTimes(2),
    );

    controller.abort();
    await expect(running).resolves.toBeUndefined();
  });

  test("runs a requested reconcile after an in-progress scan finishes", async () => {
    let finishScan: (() => void) | undefined;
    mocks.codebaseReconcile
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishScan = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const controller = new AbortController();
    const running = runAgent(config, controller.signal);

    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    expect(mocks.codebaseReconcile).toHaveBeenCalledTimes(1);
    const onEvent = mocks.subscribe.mock.calls[0]?.[2] as (event: {
      type: string;
      job: null;
    }) => void;
    onEvent({ type: "CODEBASE_RECONCILE_REQUESTED", job: null });
    expect(mocks.codebaseReconcile).toHaveBeenCalledTimes(1);

    finishScan!();
    await vi.waitFor(() =>
      expect(mocks.codebaseReconcile).toHaveBeenCalledTimes(2),
    );

    controller.abort();
    await expect(running).resolves.toBeUndefined();
  });
});
