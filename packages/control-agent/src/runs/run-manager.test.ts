import { describe, expect, test, vi } from "vitest";

import type { RunCommand } from "../graphql-client.js";
import { RunManager } from "./run-manager.js";

function command(id: string, type: string): RunCommand {
  return {
    id,
    runId: "run-1",
    agentId: "agent-1",
    sequence: type === "CANCEL" ? 1 : 0,
    type,
    payload: {},
    status: "QUEUED",
    error: null,
    run: { id: "run-1" },
  } as unknown as RunCommand;
}

describe("RunManager command priority", () => {
  test("runs cancellation without waiting for the active run command", async () => {
    let releaseStart!: () => void;
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const calls: string[] = [];
    const manager = new RunManager({} as never);
    const testable = manager as unknown as {
      runCommand: (value: RunCommand, startup: boolean) => Promise<void>;
      interruptionRequests: Map<string, "PAUSED" | "CANCELLED">;
    };
    testable.runCommand = vi.fn(async (value) => {
      calls.push(value.type);
      if (value.type === "CONTINUE") await startBlocked;
    });

    manager.execute(command("continue-1", "CONTINUE"));
    await vi.waitFor(() => expect(calls).toEqual(["CONTINUE"]));

    manager.execute(command("cancel-1", "CANCEL"));
    await vi.waitFor(() => expect(calls).toEqual(["CONTINUE", "CANCEL"]));
    expect(testable.interruptionRequests.get("run-1")).toBe("CANCELLED");

    releaseStart();
    await vi.waitFor(() =>
      expect(testable.interruptionRequests.has("run-1")).toBe(false),
    );
  });

  test("does not complete a pause until the provider has settled", async () => {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const completeRunCommand = vi.fn().mockResolvedValue(undefined);
    const manager = new RunManager({ completeRunCommand } as never);
    const testable = manager as unknown as {
      active: Map<string, unknown>;
      interruptRun: (value: RunCommand) => Promise<void>;
    };
    testable.active.set("run-1", {
      handle: { interrupt },
      attemptId: "attempt-1",
      commandId: "start-1",
      settled,
    });

    const pausing = testable.interruptRun(command("pause-1", "PAUSE"));
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith("PAUSED"));
    expect(completeRunCommand).not.toHaveBeenCalled();

    settle();
    await pausing;
    expect(completeRunCommand).toHaveBeenCalledWith("pause-1", "SUCCEEDED");
  });

  test("cancels and awaits an active provider before native deletion", async () => {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const completeRunCommand = vi.fn().mockResolvedValue(undefined);
    const manager = new RunManager({ completeRunCommand } as never);
    const testable = manager as unknown as {
      active: Map<string, unknown>;
      adapters: { get: (key: string) => unknown };
      deleteNative: (value: RunCommand) => Promise<void>;
    };
    testable.active.set("run-1", {
      handle: { interrupt },
      attemptId: "attempt-1",
      commandId: "start-1",
      settled,
    });
    testable.adapters = {
      get: (key) => (key === "CODEX" ? { delete: remove } : undefined),
    };
    const deleting = testable.deleteNative({
      ...command("delete-1", "DELETE_NATIVE"),
      run: {
        id: "run-1",
        status: "IN_PROGRESS",
        provider: "CODEX",
        worktree: { folder: "/workspace/aide" },
        attempts: [{ id: "attempt-1", generation: 0, nativeId: "thread-1" }],
      },
    } as RunCommand);

    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith("CANCELLED"));
    expect(remove).not.toHaveBeenCalled();

    settle();
    await deleting;
    expect(remove).toHaveBeenCalledWith("thread-1", "/workspace/aide");
    expect(completeRunCommand).toHaveBeenCalledWith("delete-1", "SUCCEEDED");
  });
});
