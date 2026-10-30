import { afterEach, describe, expect, test, vi } from "vitest";

import type { RunCommand } from "../graphql-client.js";
import { RunManager } from "./run-manager.js";
import { AgentRequestError } from "../request-errors.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
  test("native form cancellation during interruption does not restart deferred steering", async () => {
    const manager = new RunManager({} as never);
    const testable = manager as unknown as {
      active: Map<string, unknown>;
      pendingQuestions: Map<string, Set<string>>;
      deferredSteering: Map<string, RunCommand[]>;
      sendSteering: (value: RunCommand) => Promise<void>;
      releaseQuestion: (runId: string, requestId: string) => Promise<void>;
    };
    testable.active.set("run-1", { interrupted: true });
    testable.pendingQuestions.set("run-1", new Set(["frm_one"]));
    testable.deferredSteering.set("run-1", [command("steer", "STEER")]);
    testable.sendSteering = vi.fn();
    await testable.releaseQuestion("run-1", "frm_one");
    expect(testable.sendSteering).not.toHaveBeenCalled();
    expect(testable.deferredSteering.get("run-1")).toHaveLength(1);
  });
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

describe("RunManager history sync", () => {
  test("shutdown awaits an in-flight import without starting another provider", async () => {
    const codebases = Promise.withResolvers<unknown[]>();
    const client = { agentCodebases: vi.fn(() => codebases.promise) };
    const manager = new RunManager(client as never);
    const testable = manager as unknown as {
      adapters: { values(): unknown[] };
      syncImports(): Promise<void>;
    };
    const discover = vi.fn();
    vi.spyOn(testable.adapters, "values").mockReturnValue([
      { key: "CODEX", capabilities: {}, discover },
    ]);
    const importing = testable.syncImports();
    const closing = manager.close();
    codebases.resolve([]);
    await Promise.all([importing, closing]);
    expect(discover).not.toHaveBeenCalled();
  });

  test("starts command recovery without waiting for historical imports", async () => {
    const imported = Promise.withResolvers<void>();
    const client = { pendingRunCommands: vi.fn().mockResolvedValue([]) };
    const manager = new RunManager(client as never);
    const testable = manager as unknown as { syncImports(): Promise<void> };
    vi.spyOn(testable, "syncImports").mockReturnValue(imported.promise);
    try {
      await manager.start();
      expect(client.pendingRunCommands).toHaveBeenCalledOnce();
    } finally {
      imported.resolve();
      await manager.close();
    }
  });

  test("sends only changed snapshots and retries snapshots after a failed upload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const initial = {
      nativeId: "thread-1",
      worktreeId: "worktree-1",
      prompt: "initial",
    };
    const discover = vi.fn().mockResolvedValue([initial]);
    const client = {
      agentCodebases: vi.fn().mockResolvedValue([]),
      reportRunProviderImportStatus: vi.fn().mockResolvedValue({}),
      importProviderRuns: vi.fn().mockResolvedValue({}),
    };
    const manager = new RunManager(client as never);
    const testable = manager as unknown as {
      adapters: { values(): unknown[] };
      syncImports(): Promise<void>;
    };
    vi.spyOn(testable.adapters, "values").mockReturnValue([
      { key: "CODEX", capabilities: {}, discover },
    ]);
    try {
      await testable.syncImports();
      await testable.syncImports();
      expect(
        client.importProviderRuns.mock.calls.map(([, batch]) => batch),
      ).toEqual([[initial], []]);
      const changed = { ...initial, prompt: "changed" };
      discover.mockResolvedValue([changed]);
      client.importProviderRuns.mockRejectedValueOnce(new Error("offline"));
      await testable.syncImports();
      await testable.syncImports();
      expect(
        client.importProviderRuns.mock.calls.slice(2).map(([, batch]) => batch),
      ).toEqual([[changed], [changed]]);
      await testable.syncImports();
      expect(client.importProviderRuns).toHaveBeenLastCalledWith("CODEX", []);
      discover.mockResolvedValue([{ ...changed, status: "IN_PROGRESS" }]);
      await testable.syncImports();
      await testable.syncImports();
      expect(client.importProviderRuns.mock.calls.at(-1)![1]).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test("splits large snapshots across requests without truncating a session", async () => {
    const records = ["thread-1", "thread-2"].map((nativeId) => ({
      nativeId,
      worktreeId: "worktree-1",
      events: [{ detailMarkdown: "x".repeat(3 * 1024 * 1024) }],
    }));
    const client = {
      agentCodebases: vi.fn().mockResolvedValue([]),
      reportRunProviderImportStatus: vi.fn(),
      importProviderRuns: vi.fn(),
    };
    const manager = new RunManager(client as never);
    const testable = manager as unknown as {
      adapters: { values(): unknown[] };
      syncImports(): Promise<void>;
    };
    vi.spyOn(testable.adapters, "values").mockReturnValue([
      {
        key: "CODEX",
        capabilities: {},
        discover: vi.fn().mockResolvedValue(records),
      },
    ]);
    try {
      await testable.syncImports();
      expect(
        client.importProviderRuns.mock.calls.map(([, batch]) => batch),
      ).toEqual([[records[0]], [records[1]]]);
    } finally {
      await manager.close();
    }
  });
});

describe("RunManager request retries", () => {
  test("bounds retries and stops on permanent errors", async () => {
    vi.useFakeTimers();
    const manager = new RunManager({} as never);
    const testable = manager as unknown as {
      retry(operation: () => Promise<unknown>): Promise<unknown>;
    };
    const operation = vi.fn().mockRejectedValue(new Error("offline"));
    const failed = expect(testable.retry(operation)).rejects.toThrow("offline");
    await vi.runAllTimersAsync();
    await failed;
    expect(operation).toHaveBeenCalledTimes(5);
    operation
      .mockClear()
      .mockRejectedValue(new AgentRequestError("Unauthorized", 401));
    await expect(testable.retry(operation)).rejects.toThrow("Unauthorized");
    expect(operation).toHaveBeenCalledOnce();
    await manager.close();
  });
});
