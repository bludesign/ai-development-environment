import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type {
  AgentGraphQLClient,
  RunAttachment,
  RunCommand,
  RunRecord,
} from "../graphql-client.js";
import { configPath } from "../config.js";
import {
  captureGitCheckpoint,
  compareGitCheckpoint,
  restoreGitCheckpoint,
  type GitCheckpointReference,
} from "./git-checkpoint.js";
import { RunJournal } from "./journal.js";
import { createProviderAdapterRegistry } from "./adapter-registry.js";
import type {
  ProviderAdapter,
  ProviderCallbacks,
  ProviderHandle,
  ProviderImportWorktree,
  ProviderUsage,
  StagedAttachment,
} from "./provider.js";

const execFileAsync = promisify(execFile);
const IMPORT_INTERVAL_MS = 5 * 60 * 1_000;
const COMMAND_RECONCILIATION_INTERVAL_MS = 10_000;

type ActiveRun = {
  handle: ProviderHandle;
  attemptId: string;
  commandId: string;
  journal: RunJournal;
  settled: Promise<void>;
};

function safeFilename(value: string): string {
  return (
    value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "attachment"
  );
}

function latestNativeId(run: Pick<RunRecord, "attempts"> | null | undefined) {
  return [...(run?.attempts ?? [])]
    .sort((left, right) => right.generation - left.generation)
    .find(({ nativeId }) => nativeId)?.nativeId;
}

function totalCost(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const found = totalCost(candidate);
      if (found !== null) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["totalCost", "cost", "estimatedCost"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate))
      return candidate;
  }
  for (const key of ["totals", "data", "sessions", "session"]) {
    const found = totalCost(record[key]);
    if (found !== null) return found;
  }
  return null;
}

export class RunManager {
  private readonly adapters = createProviderAdapterRegistry();
  private readonly active = new Map<string, ActiveRun>();
  private readonly executingCommands = new Set<string>();
  private readonly pendingQuestions = new Map<string, Set<string>>();
  private readonly deferredSteering = new Map<string, RunCommand[]>();
  private readonly runQueues = new Map<string, Promise<void>>();
  private importTimer?: ReturnType<typeof setTimeout>;
  private commandTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly client: AgentGraphQLClient) {}

  async start(): Promise<void> {
    if (typeof this.client.pendingRunCommands !== "function") return;
    await this.syncImports();
    try {
      const commands = await this.client.pendingRunCommands();
      await Promise.all(commands.map((command) => this.execute(command, true)));
    } catch (error) {
      console.error(
        "Initial run command reconciliation failed; continuing:",
        error instanceof Error ? error.message : error,
      );
    }
    this.scheduleCommandReconciliation();
  }

  private scheduleCommandReconciliation(): void {
    if (this.stopped || this.commandTimer) return;
    this.commandTimer = setTimeout(() => {
      this.commandTimer = undefined;
      void this.reconcileCommands();
    }, COMMAND_RECONCILIATION_INTERVAL_MS);
    this.commandTimer.unref();
  }

  private async reconcileCommands(): Promise<void> {
    try {
      const commands = await this.client.pendingRunCommands();
      for (const command of commands) this.execute(command);
    } catch (error) {
      console.error(
        "Run command reconciliation failed; retrying:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.scheduleCommandReconciliation();
    }
  }

  execute(command: RunCommand, startup = false): void {
    if (this.stopped || this.executingCommands.has(command.id)) return;
    this.executingCommands.add(command.id);
    const previous = this.runQueues.get(command.runId) ?? Promise.resolve();
    const running = previous
      .catch(() => undefined)
      .then(() => this.runCommand(command, startup))
      .catch((error) => {
        console.error(
          `Run command ${command.id} failed:`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        const deferred = (this.deferredSteering.get(command.runId) ?? []).some(
          ({ id }) => id === command.id,
        );
        const active = this.active.get(command.runId)?.commandId === command.id;
        if (!deferred && !active) this.executingCommands.delete(command.id);
        if (this.runQueues.get(command.runId) === running) {
          this.runQueues.delete(command.runId);
        }
      });
    this.runQueues.set(command.runId, running);
  }

  private async runCommand(
    command: RunCommand,
    startup: boolean,
  ): Promise<void> {
    const claimed = await this.client.claimRunCommand(command.id);
    if (
      startup &&
      command.status === "RUNNING" &&
      [
        "START",
        "PLAY_PLAN",
        "CONTINUE",
        "REVISE_ANSWER",
        "STEER",
        "ANSWER",
        "PAUSE",
        "CANCEL",
        "PREPARE_ANSWER_REVISION",
      ].includes(command.type)
    ) {
      const latest = [...claimed.run.attempts].sort(
        (left, right) => right.generation - left.generation,
      )[0];
      if (latest) {
        await this.retry(() =>
          this.client.finishRunAttempt(latest.id, {
            status: "PAUSED",
            phase: "RECOVERY_PAUSED",
            error: "Control agent restarted while this run was active",
          }),
        );
      }
      await this.client.completeRunCommand(
        claimed.id,
        "FAILED",
        "Control agent restarted; destructive work was not replayed",
      );
      return;
    }

    try {
      switch (claimed.type) {
        case "START":
        case "PLAY_PLAN":
        case "CONTINUE":
          await this.startRun(claimed);
          return;
        case "PAUSE":
        case "CANCEL":
          await this.interruptRun(claimed);
          return;
        case "STEER":
          await this.steerRun(claimed);
          return;
        case "ANSWER":
          await this.answerRun(claimed);
          return;
        case "PREPARE_ANSWER_REVISION":
          await this.prepareAnswerRevision(claimed);
          return;
        case "REVISE_ANSWER":
          await this.reviseAnswer(claimed);
          return;
        case "DELETE_NATIVE":
          await this.deleteNative(claimed);
          return;
        default:
          throw new Error(`Unsupported run command ${claimed.type}`);
      }
    } catch (error) {
      await this.client.completeRunCommand(
        claimed.id,
        "FAILED",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async startRun(command: RunCommand): Promise<void> {
    const { run } = command;
    if (!run.worktree) throw new Error("Run worktree is unavailable");
    if (this.active.has(run.id)) throw new Error("Run is already active");
    const adapter = this.adapters.get(run.provider);
    if (!adapter) throw new Error(`Provider ${run.provider} is unavailable`);

    const attempt = await this.client.beginRunAttempt(run.id);
    if (command.type === "REVISE_ANSWER") {
      await this.client.applyRunAnswerRevision(
        String(command.payload.batchId ?? ""),
        String(command.payload.revisionId ?? ""),
        attempt.id,
      );
    }
    const journal = new RunJournal(run.id, attempt.id);
    const initialInput =
      command.type === "CONTINUE"
        ? {
            prompt: "Continue from where you stopped.",
            attachments: [] as RunAttachment[],
          }
        : command.type === "REVISE_ANSWER"
          ? run.inputs.find(
              ({ id }) => id === String(command.payload.inputId ?? ""),
            )!
          : run.inputs[0]!;
    if (!initialInput) throw new Error("Run input is unavailable");
    const attachments = await this.stageAttachments(
      run.id,
      initialInput.attachments,
    );
    const baseline = await captureGitCheckpoint(
      run.worktree.folder,
      run.id,
      command.type === "CONTINUE" ? "CONTINUE" : "START",
    );
    await this.client.reportRunCheckpoint(run.id, attempt.id, baseline);
    const resumeNativeId =
      command.type === "CONTINUE"
        ? latestNativeId(run)
        : command.type === "PLAY_PLAN"
          ? latestNativeId(run.sourcePlan)
          : run.parentRun &&
              run.parentRun.provider === run.provider &&
              String(command.payload.followUpMode ?? "") === "RESUME"
            ? latestNativeId(run.parentRun)
            : undefined;

    const callbacks: ProviderCallbacks = {
      onNativeId: async (nativeId, providerVersion) => {
        await this.retry(() =>
          this.client.updateRunAttemptNativeId(
            attempt.id,
            nativeId,
            providerVersion,
          ),
        );
      },
      onEvent: async (event) => {
        await journal.append(event);
        try {
          await journal.flush(this.client);
        } catch (error) {
          console.error(
            `Run ${run.id} event upload deferred:`,
            error instanceof Error ? error.message : error,
          );
        }
      },
      onQuestion: async (nativeRequestId, questions) => {
        const pending = this.pendingQuestions.get(run.id) ?? new Set<string>();
        pending.add(nativeRequestId);
        this.pendingQuestions.set(run.id, pending);
        const checkpoint = await captureGitCheckpoint(
          run.worktree!.folder,
          run.id,
          "QUESTION",
        );
        const eventSequence = await journal.latestSequence();
        const batch = await this.retry(() =>
          this.client.reportRunQuestion({
            runId: run.id,
            attemptId: attempt.id,
            nativeRequestId,
            eventSequence,
            questions,
          }),
        );
        await this.retry(() =>
          this.client.reportRunCheckpoint(run.id, attempt.id, {
            ...checkpoint,
            questionBatchId: batch.id,
          }),
        );
      },
      onUsage: async (usage) => {
        await this.retry(() =>
          this.client.reportRunUsage(
            run.id,
            attempt.id,
            usage as unknown as Record<string, unknown>,
          ),
        );
      },
    };

    let handle: ProviderHandle;
    try {
      handle = await adapter.start(
        {
          run,
          prompt: initialInput.prompt,
          attachments,
          resumeNativeId: resumeNativeId || undefined,
          fork: command.type !== "CONTINUE",
        },
        callbacks,
      );
    } catch (error) {
      await this.client.finishRunAttempt(attempt.id, {
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const active: ActiveRun = {
      handle,
      attemptId: attempt.id,
      commandId: command.id,
      journal,
      settled: Promise.resolve(),
    };
    this.active.set(run.id, active);
    active.settled = this.finishRun(
      command,
      attempt.id,
      handle,
      journal,
      adapter,
      baseline,
    );
    void active.settled;
  }

  private async finishRun(
    command: RunCommand,
    attemptId: string,
    handle: ProviderHandle,
    journal: RunJournal,
    adapter: ProviderAdapter,
    baseline: GitCheckpointReference,
  ): Promise<void> {
    const { run } = command;
    try {
      const completion = await handle.completion;
      await journal.flush(this.client).catch(() => undefined);
      if (run.worktree) {
        const finalCheckpoint = await captureGitCheckpoint(
          run.worktree.folder,
          run.id,
          "FINAL",
        );
        const comparison = await compareGitCheckpoint(
          run.worktree.folder,
          baseline,
          finalCheckpoint,
        );
        await this.retry(() =>
          this.client.reportRunCheckpoint(run.id, attemptId, {
            ...finalCheckpoint,
            diffPatch: comparison.rollbackPatch,
          }),
        );
      }
      const nativeId = handle.nativeId || latestNativeId(run);
      if (nativeId) {
        const usage = await this.estimatedCost(run.provider, nativeId);
        if (usage) {
          await this.client
            .reportRunUsage(
              run.id,
              attemptId,
              usage as unknown as Record<string, unknown>,
            )
            .catch(() => undefined);
        }
      }
      await this.retry(() =>
        this.client.finishRunAttempt(attemptId, {
          status: completion.status,
          finalOutput: completion.finalOutput,
          error: completion.error,
        }),
      );
      await this.retry(() =>
        this.client.completeRunCommand(
          command.id,
          completion.status === "FAILED" ? "FAILED" : "SUCCEEDED",
          completion.error,
        ),
      );
    } catch (error) {
      await this.retry(() =>
        this.client.finishRunAttempt(attemptId, {
          status: "FAILED",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.retry(() =>
        this.client.completeRunCommand(
          command.id,
          "FAILED",
          error instanceof Error ? error.message : String(error),
        ),
      );
    } finally {
      if (this.active.get(run.id)?.attemptId === attemptId)
        this.active.delete(run.id);
      this.executingCommands.delete(command.id);
      await rm(join(dirname(configPath()), "runs", run.id, "attachments"), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      void adapter;
    }
  }

  private async interruptRun(command: RunCommand): Promise<void> {
    const active = this.active.get(command.runId);
    if (!active) {
      const latest = [...command.run.attempts].sort(
        (left, right) => right.generation - left.generation,
      )[0];
      if (latest) {
        await this.client.finishRunAttempt(latest.id, {
          status: command.type === "PAUSE" ? "PAUSED" : "CANCELLED",
          phase: command.type === "PAUSE" ? "RECOVERY_PAUSED" : "CANCELLED",
        });
      }
    } else {
      await active.handle.interrupt(
        command.type === "PAUSE" ? "PAUSED" : "CANCELLED",
      );
    }
    const deferred = this.deferredSteering.get(command.runId) ?? [];
    this.deferredSteering.delete(command.runId);
    await Promise.all(
      deferred.map((entry) =>
        this.client.completeRunCommand(
          entry.id,
          "FAILED",
          "Run was interrupted before queued steering could be sent",
        ),
      ),
    );
    for (const entry of deferred) this.executingCommands.delete(entry.id);
    await this.client.completeRunCommand(command.id, "SUCCEEDED");
  }

  private async steerRun(command: RunCommand): Promise<void> {
    if (
      command.payload.queuedBehindQuestion &&
      this.pendingQuestions.get(command.runId)?.size
    ) {
      const deferred = this.deferredSteering.get(command.runId) ?? [];
      deferred.push(command);
      this.deferredSteering.set(command.runId, deferred);
      return;
    }
    await this.sendSteering(command);
  }

  private async sendSteering(command: RunCommand): Promise<void> {
    const active = this.active.get(command.runId);
    if (!active) throw new Error("Run is not active on this agent");
    const inputId = String(command.payload.inputId ?? "");
    const input = command.run.inputs.find(({ id }) => id === inputId);
    if (!input) throw new Error("Steering input not found");
    const attachments = await this.stageAttachments(
      command.runId,
      input.attachments,
    );
    await active.handle.steer(input.prompt, attachments);
    await this.client.completeRunCommand(command.id, "SUCCEEDED");
    this.executingCommands.delete(command.id);
  }

  private async answerRun(command: RunCommand): Promise<void> {
    const active = this.active.get(command.runId);
    if (!active) throw new Error("Run is not active on this agent");
    const requestId = String(command.payload.nativeRequestId ?? "");
    await active.handle.answer(requestId, command.payload.answers);
    const pending = this.pendingQuestions.get(command.runId);
    pending?.delete(requestId);
    if (!pending?.size) {
      this.pendingQuestions.delete(command.runId);
      const deferred = this.deferredSteering.get(command.runId) ?? [];
      this.deferredSteering.delete(command.runId);
      for (const steering of deferred) await this.sendSteering(steering);
    }
    await this.client.completeRunCommand(command.id, "SUCCEEDED");
  }

  private checkpointFromCommand(command: RunCommand): GitCheckpointReference {
    const value = command.payload.checkpoint;
    if (!value || typeof value !== "object")
      throw new Error("Question checkpoint is missing");
    const checkpoint = value as Record<string, unknown>;
    const optional = (key: string) =>
      typeof checkpoint[key] === "string" ? String(checkpoint[key]) : null;
    return {
      headSha: optional("headSha"),
      branch: optional("branch"),
      upstreamSha: optional("upstreamSha"),
      indexTree: optional("indexTree"),
      worktreeTree: optional("worktreeTree"),
      refName: optional("refName"),
    };
  }

  private async prepareAnswerRevision(command: RunCommand): Promise<void> {
    if (!command.run.worktree) throw new Error("Run worktree is unavailable");
    const active = this.active.get(command.runId);
    if (active) {
      await active.handle.interrupt("PAUSED");
      await active.settled;
    }
    const current = await captureGitCheckpoint(
      command.run.worktree.folder,
      command.runId,
      "PRE_ANSWER_REVISION",
    );
    const latestAttempt = [...command.run.attempts].sort(
      (left, right) => right.generation - left.generation,
    )[0];
    await this.client.reportRunCheckpoint(
      command.runId,
      latestAttempt?.id ?? null,
      current,
    );
    const preview = await compareGitCheckpoint(
      command.run.worktree.folder,
      this.checkpointFromCommand(command),
      current,
    );
    await this.client.reportRunAnswerRevisionPreview(
      String(command.payload.batchId ?? ""),
      preview.rollbackPatch,
      preview.pushedCommitWarning,
    );
    await this.client.completeRunCommand(command.id, "SUCCEEDED");
  }

  private async reviseAnswer(command: RunCommand): Promise<void> {
    if (!command.run.worktree) throw new Error("Run worktree is unavailable");
    const stashRef = await restoreGitCheckpoint(
      command.run.worktree.folder,
      this.checkpointFromCommand(command),
      {
        stash: Boolean(command.payload.stash),
        message: `AIDE run ${command.runId} before answer revision`,
      },
    );
    const restored = await captureGitCheckpoint(
      command.run.worktree.folder,
      command.runId,
      "ANSWER_ROLLBACK",
    );
    await this.client.reportRunCheckpoint(command.runId, null, {
      ...restored,
      stashRef,
    });
    await this.startRun(command);
  }

  private async deleteNative(command: RunCommand): Promise<void> {
    if (!command.run.worktree) throw new Error("Run worktree is unavailable");
    const adapter = this.adapters.get(command.run.provider);
    if (!adapter)
      throw new Error(`Provider ${command.run.provider} is unavailable`);
    for (const attempt of command.run.attempts) {
      if (!attempt.nativeId) continue;
      try {
        await adapter.delete(attempt.nativeId, command.run.worktree.folder);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/(?:not found|unknown (?:session|thread)|\b404\b)/i.test(message))
          throw error;
      }
    }
    await this.client.completeRunCommand(command.id, "SUCCEEDED");
  }

  private async stageAttachments(
    runId: string,
    attachments: RunAttachment[],
  ): Promise<StagedAttachment[]> {
    if (!attachments.length) return [];
    const directory = join(dirname(configPath()), "runs", runId, "attachments");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return Promise.all(
      attachments.map(async (attachment) => {
        const path = join(
          directory,
          `${attachment.id}-${safeFilename(attachment.filename)}`,
        );
        await this.client.downloadRunAttachment(attachment, path);
        return { ...attachment, path };
      }),
    );
  }

  private async estimatedCost(
    provider: RunRecord["provider"],
    nativeId: string,
  ): Promise<ProviderUsage | null> {
    const command =
      provider === "OPENCODE" ? "opencode" : provider.toLowerCase();
    for (const offline of [false, true]) {
      try {
        const args = [command, "session", "--id", nativeId, "--json"];
        if (offline) args.push("--offline");
        const { stdout } = await execFileAsync("ccusage", args, {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        });
        const parsed = JSON.parse(stdout) as unknown;
        const cost = totalCost(parsed);
        if (cost !== null) {
          return {
            model: "estimated-total",
            estimatedCost: cost,
            pricingSource: offline ? "ccusage-offline" : "ccusage",
          };
        }
      } catch {
        // Retry once with ccusage's cached pricing catalog.
      }
    }
    return null;
  }

  private async syncImports(): Promise<void> {
    if (this.stopped) return;
    try {
      const codebases = await this.client.agentCodebases();
      const worktrees: ProviderImportWorktree[] = codebases.flatMap(
        (codebase) =>
          codebase.worktrees.map((worktree) => ({
            id: worktree.id,
            folder: worktree.folder,
            branch: worktree.branch,
          })),
      );
      for (const adapter of this.adapters.values()) {
        try {
          const catalog = await adapter.catalog?.();
          await this.client.reportRunProviderImportStatus(
            adapter.key,
            "SYNCING",
            undefined,
            { ...catalog, capabilities: adapter.capabilities },
          );
          const runs = await adapter.discover(worktrees);
          await this.client.importProviderRuns(
            adapter.key,
            runs as unknown as Array<Record<string, unknown>>,
          );
        } catch (error) {
          await this.client
            .reportRunProviderImportStatus(
              adapter.key,
              "FAILED",
              error instanceof Error ? error.message : String(error),
            )
            .catch(() => undefined);
          console.error(
            `${adapter.key} history sync failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    } catch (error) {
      console.error(
        "Provider history sync failed:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      if (!this.stopped) {
        this.importTimer = setTimeout(
          () => void this.syncImports(),
          IMPORT_INTERVAL_MS,
        );
        this.importTimer.unref();
      }
    }
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let delay = 1_000;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (this.stopped) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.importTimer) clearTimeout(this.importTimer);
    if (this.commandTimer) clearTimeout(this.commandTimer);
    for (const active of this.active.values()) {
      await active.handle.interrupt("PAUSED").catch(() => undefined);
    }
    await Promise.allSettled(
      this.adapters.values().map((adapter) => adapter.close?.()),
    );
  }
}
