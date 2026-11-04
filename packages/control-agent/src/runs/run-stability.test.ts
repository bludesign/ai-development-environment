import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RunCommand } from "../graphql-client.js";
import type { ProviderHandle } from "./provider.js";

const state = vi.hoisted(() => ({ config: "" }));
vi.mock("../config.js", () => ({ configPath: () => state.config }));
vi.mock("./git-checkpoint.js", () => ({
  captureGitCheckpoint: vi.fn(async () => ({ ref: "checkpoint" })),
  compareGitCheckpoint: vi.fn(async () => ({
    worktreePatch: "",
    worktreeSummary: "",
  })),
  restoreGitCheckpoint: vi.fn(),
}));
vi.mock("./journal.js", () => ({
  RunJournal: class {
    eventsPath = "/unused/events";
    async flush() {}
  },
}));
import { RunManager } from "./run-manager.js";
import { RepositoryCoordinator } from "../repository-coordinator.js";
import {
  spawnExecutionProcess,
  withExecutionJournal,
  forgetExecution,
  executionEnvironment,
} from "../execution-recovery.js";
import { restoreGitCheckpoint } from "./git-checkpoint.js";

let directory: string;
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), "aide-run-stability-")),
  );
  state.config = join(directory, "agent", "config.json");
  await mkdir(join(directory, "git"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function managedCommand(executionToken?: string): RunCommand {
  return {
    id: "command",
    runId: "run",
    agentId: "agent",
    sequence: 0,
    type: "START",
    payload: {},
    status: "QUEUED",
    error: null,
    executionToken,
    run: {
      id: "run",
      kind: "SESSION",
      origin: "MANAGED",
      provider: "CODEX",
      worktree: {
        id: "worktree",
        folder: directory,
        gitDirectory: join(directory, "git"),
        codebaseId: "codebase",
        branch: "main",
      },
      inputs: [{ id: "input", prompt: "Edit files", attachments: [] }],
      attempts: [],
      mcpToolNames: [],
    },
  } as unknown as RunCommand;
}

const identity = (token: string) => ({
  agentId: "agent",
  jobId: "provider:command",
  executionToken: token,
});

describe("managed provider source stability", () => {
  test("journals answer rollback mutations before starting the replacement provider", async () => {
    const token = randomUUID();
    const command = {
      ...managedCommand(token),
      type: "REVISE_ANSWER",
      payload: { checkpoint: {} },
    };
    const manager = new RunManager({
      reportRunCheckpoint: vi.fn(async () => undefined),
    } as never);
    const internal = manager as unknown as {
      providerExecutions: Map<string, ReturnType<typeof identity>>;
      reviseAnswer(command: RunCommand): Promise<void>;
      startRun(command: RunCommand): Promise<void>;
      adapters: { values(): unknown[] };
    };
    internal.providerExecutions.set(command.id, identity(token));
    vi.mocked(restoreGitCheckpoint).mockImplementationOnce(async () => {
      expect(executionEnvironment().AIDE_EXECUTION_MARKER).toBeTruthy();
      return null;
    });
    const start = vi
      .spyOn(internal, "startRun")
      .mockImplementation(async () => {
        expect(executionEnvironment()).toEqual({});
      });
    vi.spyOn(internal.adapters, "values").mockReturnValue([]);
    try {
      await internal.reviseAnswer(command);
      expect(restoreGitCheckpoint).toHaveBeenCalled();
      expect(start).toHaveBeenCalledWith(command);
    } finally {
      forgetExecution(identity(token));
      await manager.close();
    }
  });
  test("keeps startup closed until prior provider recovery settles without waiting for new sessions", async () => {
    const cleanup = Promise.withResolvers<void>();
    const prior = { ...managedCommand(randomUUID()), status: "RUNNING" };
    const queued = {
      ...managedCommand(),
      id: "queued",
      runId: "next",
      run: { ...managedCommand().run, id: "next" },
    };
    const manager = new RunManager({
      pendingRunCommands: vi.fn(async () => [prior, queued]),
    } as never);
    const internal = manager as unknown as {
      syncImports(): Promise<void>;
      runCommand(command: RunCommand, startup: boolean): Promise<void>;
      adapters: { values(): unknown[] };
    };
    vi.spyOn(internal, "syncImports").mockResolvedValue(undefined);
    vi.spyOn(internal.adapters, "values").mockReturnValue([]);
    const run = vi
      .spyOn(internal, "runCommand")
      .mockImplementation(async (command) => {
        if (command.id === prior.id) await cleanup.promise;
      });
    try {
      let ready = false;
      const starting = manager.start().then(() => {
        ready = true;
      });
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      expect(ready).toBe(false);
      expect(manager.isStartupRecoveryPending()).toBe(true);
      cleanup.resolve();
      await starting;
      expect(manager.isStartupRecoveryPending()).toBe(false);
      await vi.waitFor(() => expect(run).toHaveBeenCalledWith(queued, false));
    } finally {
      cleanup.resolve();
      await manager.close();
    }
  });
  test("defers new execution until legacy sessions drain on their original agent", async () => {
    const legacy = {
      ...managedCommand("run:agent:command"),
      status: "RUNNING",
    };
    const client = {
      pendingRunCommands: vi.fn(async () => [legacy]),
      claimRunCommand: vi.fn(),
    };
    const manager = new RunManager(client as never);
    const internal = manager as unknown as {
      syncImports(): Promise<void>;
      reconcileCommands(): Promise<void>;
      adapters: { values(): unknown[] };
    };
    vi.spyOn(internal, "syncImports").mockResolvedValue(undefined);
    vi.spyOn(internal.adapters, "values").mockReturnValue([]);
    try {
      await manager.start();
      expect(manager.isStartupRecoveryPending()).toBe(true);
      manager.execute(managedCommand());
      expect(client.claimRunCommand).not.toHaveBeenCalled();
      client.pendingRunCommands.mockResolvedValue([]);
      await internal.reconcileCommands();
      expect(manager.isStartupRecoveryPending()).toBe(false);
    } finally {
      await manager.close();
    }
  });
  test.skipIf(process.platform === "win32")(
    "holds build exclusion beyond START acknowledgement until provider process cleanup is verified",
    async () => {
      const coordinator = new RepositoryCoordinator();
      const token = randomUUID();
      const physical =
        Promise.withResolvers<Awaited<ProviderHandle["completion"]>>();
      let child: ReturnType<typeof spawnExecutionProcess> | undefined;
      let childClosed = false;
      const processAlive = () => {
        if (!child?.pid) return false;
        try {
          const status = execFileSync(
            "/bin/ps",
            ["-o", "stat=", "-p", String(child.pid)],
            { encoding: "utf8" },
          ).trim();
          return Boolean(status && !status.startsWith("Z"));
        } catch {
          return false;
        }
      };
      const client = {
        beginRunAttempt: vi.fn(async () => ({ id: "attempt", generation: 1 })),
        reportRunCheckpoint: vi.fn(async () => undefined),
        finishRunAttempt: vi.fn(async () => undefined),
        completeRunCommand: vi.fn(async () => {
          expect(processAlive()).toBe(false);
        }),
      };
      const manager = new RunManager(client as never, coordinator);
      const internal = manager as unknown as {
        providerExecutions: Map<string, ReturnType<typeof identity>>;
        adapters: { get(key: string): unknown; values(): unknown[] };
        startRun(command: RunCommand): Promise<void>;
        active: Map<string, { settled: Promise<void> }>;
      };
      internal.providerExecutions.set("command", identity(token));
      vi.spyOn(internal.adapters, "get").mockReturnValue({
        start: async () => {
          child = spawnExecutionProcess(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { stdio: "ignore" },
          );
          child.once("close", () => {
            childClosed = true;
          });
          await new Promise<void>((resolve, reject) => {
            child!.once("spawn", resolve);
            child!.once("error", reject);
          });
          return {
            completion: physical.promise,
            interrupt: async () => physical.resolve({ status: "PAUSED" }),
            steer: async () => undefined,
            answer: async () => undefined,
          };
        },
      });
      vi.spyOn(internal.adapters, "values").mockReturnValue([]);
      try {
        await internal.startRun(managedCommand(token));
        expect(processAlive()).toBe(true);
        let buildStarted = false;
        const build = coordinator.withResources(
          [
            {
              kind: "WORKTREE",
              key: `agent:build-stability:${join(directory, "git")}`,
              mode: "WRITE",
              agentId: "agent",
              codebaseId: "codebase",
            },
          ],
          async () => {
            buildStarted = true;
            expect(processAlive()).toBe(false);
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(buildStarted).toBe(false);
        expect(client.completeRunCommand).not.toHaveBeenCalled();
        const settled = internal.active.get("run")!.settled;
        physical.resolve({ status: "COMPLETED", finalOutput: "Done" });
        await Promise.all([settled, build]);
        expect(client.completeRunCommand).toHaveBeenCalledWith(
          "command",
          "SUCCEEDED",
          undefined,
          token,
        );
        expect(processAlive()).toBe(false);
      } finally {
        physical.resolve({ status: "CANCELLED" });
        if (child && !childClosed) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* Preserve the original assertion failure. */
          }
        }
        await manager.close();
      }
    },
  );

  test("recovers a terminal command retaining an execution token without replaying the provider", async () => {
    const token = randomUUID();
    await withExecutionJournal(identity(token), async () => undefined);
    const command = { ...managedCommand(token), status: "FAILED" };
    const client = {
      claimRunCommand: vi.fn(async () => command),
      completeRunCommand: vi.fn(async () => undefined),
    };
    const manager = new RunManager(client as never);
    const internal = manager as unknown as {
      runCommand(command: RunCommand, startup: boolean): Promise<void>;
      startRun(command: RunCommand): Promise<void>;
      adapters: { values(): unknown[] };
    };
    const start = vi.spyOn(internal, "startRun");
    vi.spyOn(internal.adapters, "values").mockReturnValue([]);
    try {
      await internal.runCommand(command, false);
      expect(start).not.toHaveBeenCalled();
      expect(client.claimRunCommand).toHaveBeenCalledWith("command", token);
      expect(client.completeRunCommand).toHaveBeenCalledWith(
        "command",
        "FAILED",
        expect.stringContaining("stopped and verified"),
        token,
      );
    } finally {
      await manager.close();
      forgetExecution(identity(token));
    }
  });

  test("keeps legacy provider grants held when there is no trusted execution journal", async () => {
    const command = {
      ...managedCommand("run:agent:command"),
      status: "RUNNING",
    };
    const client = {
      claimRunCommand: vi.fn(async () => command),
      completeRunCommand: vi.fn(),
    };
    const manager = new RunManager(client as never);
    const internal = manager as unknown as {
      runCommand(command: RunCommand, startup: boolean): Promise<void>;
      adapters: { values(): unknown[] };
    };
    vi.spyOn(internal.adapters, "values").mockReturnValue([]);
    try {
      await expect(internal.runCommand(command, true)).rejects.toThrow(
        "cleanup cannot be verified",
      );
      expect(client.completeRunCommand).not.toHaveBeenCalled();
    } finally {
      await manager.close();
    }
  });
});
