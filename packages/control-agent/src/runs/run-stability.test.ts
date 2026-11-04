import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
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
  recoverExecution,
} from "../execution-recovery.js";
import {
  captureGitCheckpoint,
  compareGitCheckpoint,
  restoreGitCheckpoint,
} from "./git-checkpoint.js";

let directory: string;
beforeEach(async () => {
  // An assertion can fail before a one-shot real-checkpoint implementation is
  // consumed. Do not let that implementation affect the next mocked test.
  vi.mocked(captureGitCheckpoint)
    .mockReset()
    .mockResolvedValue({ ref: "checkpoint" } as never);
  vi.mocked(compareGitCheckpoint)
    .mockReset()
    .mockResolvedValue({ worktreePatch: "", worktreeSummary: "" } as never);
  vi.mocked(restoreGitCheckpoint).mockReset();
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

async function checkpointRepository() {
  const folder = join(directory, "repository");
  await mkdir(folder);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", folder, ...args], { stdio: "ignore" });
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  await writeFile(join(folder, "trigger.txt"), "initial\n");
  git("add", "trigger.txt");
  git("commit", "-m", "Initial");
  const command = managedCommand(randomUUID());
  command.run.worktree!.folder = folder;
  command.run.worktree!.gitDirectory = join(folder, ".git");
  return { folder, git, command };
}

async function executionJournal(token: string) {
  const folder = join(directory, "agent", "executions");
  const journals = await Promise.all(
    (await readdir(folder))
      .filter((file) => file.endsWith(".json"))
      .map(async (file) =>
        JSON.parse(await readFile(join(folder, file), "utf8")),
      ),
  );
  const journal = journals.find((entry) => entry.executionToken === token);
  if (!journal) throw new Error("Execution journal is not ready");
  return journal;
}

describe("managed provider source stability", () => {
  test.skipIf(process.platform === "win32")(
    "retains the grant and source lease when final cleanup cannot be verified",
    async () => {
      const token = randomUUID();
      const completion =
        Promise.withResolvers<Awaited<ProviderHandle["completion"]>>();
      const coordinator = new RepositoryCoordinator();
      const client = {
        beginRunAttempt: vi.fn(async () => ({ id: "attempt", generation: 1 })),
        reportRunCheckpoint: vi.fn(async () => undefined),
        finishRunAttempt: vi.fn(async () => undefined),
        completeRunCommand: vi.fn(async () => undefined),
      };
      const manager = new RunManager(client as never, coordinator);
      const internal = manager as unknown as {
        providerExecutions: Map<string, ReturnType<typeof identity>>;
        adapters: { get(key: string): unknown; values(): unknown[] };
        startRun(command: RunCommand): Promise<void>;
      };
      let child: ReturnType<typeof spawnExecutionProcess> | undefined;
      let denyCleanup = true;
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (denyCleanup && child?.pid && pid === -child.pid)
          throw Object.assign(new Error("Cleanup denied"), { code: "EPERM" });
        return kill(pid, signal);
      });
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      internal.providerExecutions.set("command", identity(token));
      vi.spyOn(internal.adapters, "get").mockReturnValue({
        start: async () => {
          child = spawnExecutionProcess(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { stdio: "ignore" },
          );
          await once(child, "spawn");
          return {
            completion: completion.promise,
            interrupt: async () => completion.resolve({ status: "PAUSED" }),
          };
        },
      });
      vi.spyOn(internal.adapters, "values").mockReturnValue([]);
      let build: Promise<void> | undefined;
      try {
        await internal.startRun(managedCommand(token));
        let buildStarted = false;
        build = coordinator.withResources(
          [
            {
              kind: "WORKTREE",
              key: `agent:build-stability:${join(directory, "git")}`,
              mode: "WRITE",
              agentId: "agent",
            },
          ],
          async () => {
            buildStarted = true;
          },
        );
        completion.resolve({ status: "COMPLETED" });
        await vi.waitFor(
          async () => {
            expect((await executionJournal(token)).state).toBe("SETTLING");
          },
          { timeout: 10_000 },
        );
        expect(client.completeRunCommand).not.toHaveBeenCalled();
        expect(internal.providerExecutions.has("command")).toBe(true);
        expect(buildStarted).toBe(false);
        denyCleanup = false;
        await build;
        expect((await executionJournal(token)).state).toBe("SETTLED");
        expect(client.completeRunCommand).not.toHaveBeenCalled();
      } finally {
        denyCleanup = false;
        completion.resolve({ status: "CANCELLED" });
        // Drain the outer source lease before changing the shared config path
        // or restoring process.kill, including when a readiness check fails.
        await build;
        await manager.close();
        await recoverExecution(identity(token));
        forgetExecution(identity(token));
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "keeps final checkpoint helpers protected until cleanup and acknowledgement",
    async () => {
      const checkpoint = await vi.importActual<
        typeof import("./git-checkpoint.js")
      >("./git-checkpoint.js");
      vi.mocked(captureGitCheckpoint)
        .mockImplementationOnce(checkpoint.captureGitCheckpoint)
        .mockImplementationOnce(checkpoint.captureGitCheckpoint);
      vi.mocked(compareGitCheckpoint).mockImplementationOnce(
        checkpoint.compareGitCheckpoint,
      );
      const { folder, git, command } = await checkpointRepository();
      const token = command.executionToken!;
      const heartbeat = join(directory, "final-checkpoint-helper");
      const filter = join(folder, ".git", "clean-filter.cjs");
      await writeFile(
        filter,
        `const fs=require('node:fs');
const input=fs.readFileSync(0);
require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20);`)}],{detached:true,stdio:'ignore'}).unref();
process.stdout.write(input);`,
      );
      const finalReport = Promise.withResolvers<void>();
      const coordinator = new RepositoryCoordinator();
      const client = {
        beginRunAttempt: vi.fn(async () => ({ id: "attempt", generation: 1 })),
        reportRunCheckpoint: vi.fn(async (_run, _attempt, value) => {
          if (value.kind === "FINAL") await finalReport.promise;
        }),
        finishRunAttempt: vi.fn(async () => undefined),
        completeRunCommand: vi.fn(async () => {
          expect((await executionJournal(token)).state).toBe("SETTLED");
          const size = (await stat(heartbeat)).size;
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect((await stat(heartbeat)).size).toBe(size);
        }),
      };
      const manager = new RunManager(client as never, coordinator);
      const internal = manager as unknown as {
        providerExecutions: Map<string, ReturnType<typeof identity>>;
        adapters: { get(key: string): unknown; values(): unknown[] };
        startRun(command: RunCommand): Promise<void>;
        active: Map<string, { settled: Promise<void> }>;
      };
      internal.providerExecutions.set(command.id, identity(token));
      vi.spyOn(internal.adapters, "get").mockReturnValue({
        start: async () => {
          // Install the clean filter after START so only the real FINAL
          // checkpoint spawns this detached, continuously writing helper.
          git("config", "filter.review.clean", `node ${filter}`);
          await writeFile(
            join(folder, ".gitattributes"),
            "trigger.txt filter=review\n",
          );
          await writeFile(join(folder, "trigger.txt"), "edited\n");
          return {
            completion: Promise.resolve({ status: "COMPLETED" }),
            interrupt: async () => undefined,
            steer: async () => undefined,
            answer: async () => undefined,
          };
        },
      });
      vi.spyOn(internal.adapters, "values").mockReturnValue([]);
      let settled: Promise<void> | undefined;
      const sourceResource = {
        kind: "WORKTREE" as const,
        key: `agent:build-stability:${join(folder, ".git")}`,
        mode: "WRITE" as const,
        agentId: "agent",
      };
      try {
        await internal.startRun(command);
        settled = internal.active.get(command.runId)!.settled;
        await vi.waitFor(
          async () => {
            expect((await stat(heartbeat)).size).toBeGreaterThan(0);
            expect(client.reportRunCheckpoint).toHaveBeenCalledWith(
              command.runId,
              "attempt",
              expect.objectContaining({ kind: "FINAL" }),
            );
          },
          // This phase executes the real Git checkpoint, not the mock. Under
          // the full suite it competes with other process-heavy Git tests.
          { timeout: 10_000 },
        );
        expect((await executionJournal(token)).state).toBe("RUNNING");
        expect(client.completeRunCommand).not.toHaveBeenCalled();
        let buildStarted = false;
        const build = coordinator.withResources([sourceResource], async () => {
          buildStarted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(buildStarted).toBe(false);
        finalReport.resolve();
        await Promise.all([settled, build]);
        expect(client.completeRunCommand).toHaveBeenCalledWith(
          command.id,
          "SUCCEEDED",
          undefined,
          token,
        );
        expect(await readdir(join(directory, "agent", "executions"))).toEqual(
          [],
        );
      } finally {
        finalReport.resolve();
        await settled;
        await coordinator.withResources(
          [sourceResource],
          async () => undefined,
        );
        await manager.close();
        await recoverExecution(identity(token));
      }
    },
    20_000,
  );

  test.skipIf(process.platform === "win32")(
    "recovers a process started by the real FINAL checkpoint after an agent crash",
    async () => {
      const { folder, command } = await checkpointRepository();
      const token = command.executionToken!;
      const heartbeat = join(directory, "final-checkpoint-heartbeat");
      const filter = join(folder, ".git", "crash-filter.cjs");
      await writeFile(
        filter,
        `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20);`,
      );
      const moduleUrl = new URL("./run-manager.ts", import.meta.url).href;
      const script = `import { RunManager } from ${JSON.stringify(moduleUrl)};
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const command=${JSON.stringify(command)};
const manager=new RunManager({
  beginRunAttempt:async()=>({id:'attempt',generation:1}),
  reportRunCheckpoint:async()=>{},
  finishRunAttempt:async()=>{},
  completeRunCommand:async()=>{},
});
manager.providerExecutions.set(command.id,${JSON.stringify(identity(token))});
manager.adapters.get=()=>({start:async()=>{
  execFileSync('git',['-C',${JSON.stringify(folder)},'config','filter.review.clean',${JSON.stringify(`node ${filter}`)}]);
  writeFileSync(${JSON.stringify(join(folder, ".gitattributes"))},'trigger.txt filter=review\\n');
  writeFileSync(${JSON.stringify(join(folder, "trigger.txt"))},'edited\\n');
  return {completion:Promise.resolve({status:'COMPLETED'}),interrupt:async()=>{}};
}});
await manager.startRun(command);`;
      const agent = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          env: { ...process.env, CONTROL_AGENT_CONFIG: state.config },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      agent.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      try {
        await vi.waitFor(
          async () => {
            expect((await stat(heartbeat)).size, stderr).toBeGreaterThan(0);
          },
          { timeout: 10_000 },
        );
        expect((await executionJournal(token)).state).toBe("RUNNING");
        const exited = once(agent, "exit");
        agent.kill("SIGKILL");
        await exited;
        await recoverExecution(identity(token));
        const size = (await stat(heartbeat)).size;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect((await stat(heartbeat)).size).toBe(size);
        expect((await executionJournal(token)).state).toBe("SETTLED");
      } finally {
        const exited =
          agent.exitCode === null && agent.signalCode === null
            ? once(agent, "exit")
            : undefined;
        agent.kill("SIGKILL");
        await exited;
        await recoverExecution(identity(token));
        forgetExecution(identity(token));
      }
    },
    20_000,
  );

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
