import { beforeEach, describe, expect, test, vi } from "vitest";

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

vi.mock("./inventory.js", () => ({
  collectInventory: () => ({
    hostname: "test.local",
    version: "test",
    osVersion: "macOS test",
    architecture: "arm64",
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
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

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
});
