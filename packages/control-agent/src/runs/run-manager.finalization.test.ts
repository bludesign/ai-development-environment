import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  captureGitCheckpoint: vi.fn(),
  compareGitCheckpoint: vi.fn(),
  flush: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("./adapter-registry.js", () => ({
  createProviderAdapterRegistry: () => ({
    get: () => ({ start: mocks.start }),
    values: () => [],
  }),
}));
vi.mock("./git-checkpoint.js", () => ({
  captureGitCheckpoint: mocks.captureGitCheckpoint,
  compareGitCheckpoint: mocks.compareGitCheckpoint,
}));
vi.mock("./journal.js", () => ({
  RunJournal: class {
    flush(...args: unknown[]) {
      return mocks.flush(...args);
    }
  },
}));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), rm: mocks.rm }));

import type { RunCommand } from "../graphql-client.js";
import { AgentRequestError } from "../request-errors.js";
import type { ProviderCompletion } from "./provider.js";
import { RunManager } from "./run-manager.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.captureGitCheckpoint.mockImplementation(async (_folder, _id, kind) => ({
    kind,
  }));
  mocks.compareGitCheckpoint.mockResolvedValue({ rollbackPatch: "patch" });
  mocks.flush.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup() {
  const completion = Promise.withResolvers<ProviderCompletion>();
  const handle = {
    completion: completion.promise,
    interrupt: vi.fn().mockResolvedValue(undefined),
  };
  mocks.start.mockResolvedValue(handle);
  const client = {
    claimRunCommand: vi.fn(),
    beginRunAttempt: vi.fn().mockResolvedValue({ id: "attempt-1" }),
    reportRunCheckpoint: vi.fn().mockResolvedValue({}),
    finishRunAttempt: vi.fn().mockResolvedValue({}),
    completeRunCommand: vi.fn().mockResolvedValue({}),
  };
  const command = {
    id: "command-1",
    runId: "run-1",
    type: "START",
    payload: {},
    run: {
      id: "run-1",
      provider: "CODEX",
      worktree: { folder: "/workspace" },
      inputs: [{ prompt: "test", attachments: [] }],
      attempts: [],
    },
  } as unknown as RunCommand;
  client.claimRunCommand.mockResolvedValue(command);
  return {
    manager: new RunManager(client as never),
    client,
    command,
    completion,
  };
}

describe("RunManager finalization", () => {
  test.each([
    "reportRunCheckpoint",
    "finishRunAttempt",
    "completeRunCommand",
  ] as const)(
    "preserves completion through more than five transient %s failures",
    async (method) => {
      const { manager, client, command, completion } = setup();
      manager.execute(command);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.start).toHaveBeenCalledOnce();

      const request = client[method];
      request.mockClear().mockRejectedValue(new Error("offline"));
      completion.resolve({ status: "COMPLETED", finalOutput: "result" });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(request).toHaveBeenCalledTimes(5);

      // A reconciliation event must leave the original provider and result intact.
      manager.execute({ ...command, status: "RUNNING" });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.beginRunAttempt).toHaveBeenCalledOnce();
      expect(mocks.start).toHaveBeenCalledOnce();

      request.mockResolvedValue({});
      await vi.advanceTimersByTimeAsync(16_000);
      expect(request).toHaveBeenCalledTimes(6);
      expect(client.finishRunAttempt).toHaveBeenLastCalledWith("attempt-1", {
        status: "COMPLETED",
        finalOutput: "result",
        error: undefined,
      });
      expect(
        client.finishRunAttempt.mock.calls.every(
          ([, result]) => result.status === "COMPLETED",
        ),
      ).toBe(true);
      expect(client.completeRunCommand).toHaveBeenLastCalledWith(
        "command-1",
        "SUCCEEDED",
        undefined,
      );
      expect(mocks.captureGitCheckpoint).toHaveBeenCalledTimes(2);
      expect(mocks.rm).toHaveBeenCalledOnce();
      await manager.close();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test("handles permanent failures in detached finalization without an unhandled rejection", async () => {
    const { manager, client, command, completion } = setup();
    client.finishRunAttempt.mockRejectedValue(
      new AgentRequestError("Run not found", 404),
    );
    manager.execute(command);
    await vi.advanceTimersByTimeAsync(0);
    completion.resolve({ status: "COMPLETED", finalOutput: "result" });
    await vi.advanceTimersByTimeAsync(0);

    expect(console.error).toHaveBeenCalledWith(
      "Run run-1 finalization failed:",
      "Run not found",
    );
    expect(client.finishRunAttempt).toHaveBeenCalledTimes(2);
    expect(client.completeRunCommand).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await manager.close();
  });

  test("shutdown cancels finalization backoff without reporting the run as failed", async () => {
    const { manager, client, command, completion } = setup();
    manager.execute(command);
    await vi.advanceTimersByTimeAsync(0);
    const active = (
      manager as unknown as {
        active: Map<string, { settled: Promise<void> }>;
      }
    ).active.get("run-1")!;
    client.reportRunCheckpoint
      .mockClear()
      .mockRejectedValue(new Error("offline"));
    completion.resolve({ status: "COMPLETED", finalOutput: "result" });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.reportRunCheckpoint).toHaveBeenCalledOnce();

    await manager.close();
    await active.settled;
    expect(client.reportRunCheckpoint).toHaveBeenCalledOnce();
    expect(client.finishRunAttempt).not.toHaveBeenCalled();
    expect(client.completeRunCommand).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
