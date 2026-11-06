import {
  WORKTREE_DIFF_ASSET_JOB_KIND,
  WORKTREE_DIFF_JOB_KIND,
  WORKTREE_GIT_INSPECT_JOB_KIND,
  WORKTREE_INSPECT_JOB_KIND,
} from "@ai-development-environment/agent-contract/worktrees";
import { CODEBASE_GIT_INSPECT_JOB_KIND } from "@ai-development-environment/agent-contract/codebases";
import { IOS_BUILD_JOB_KIND } from "@ai-development-environment/agent-contract/builds";
import { parseOperationDescriptor } from "@ai-development-environment/agent-contract/operation-resources";
import { randomUUID } from "node:crypto";

import { AgentGraphQLClient, type AgentJob } from "./graphql-client.js";
import { handlers } from "./handlers/index.js";
import { closeAllWorktreeWatches } from "./handlers/worktrees.js";
import type { ProcessResult } from "./process-runner.js";
import { refreshFetchedCodebase } from "./refresh-fetched-codebase.js";
import { RepositoryCoordinator } from "./repository-coordinator.js";
import { isRetryableAgentError, waitForAgentRetry } from "./request-errors.js";
import {
  withExecutionJournal,
  recoverExecution,
  forgetExecution,
  executionCompletion,
  ProcessInspectionTimeoutError,
  type ExecutionCompletion,
} from "./execution-recovery.js";

const PROCESS_INSPECTION_WARNING =
  "Process inspection timed out after 30 seconds. The completed build result and artifacts were preserved; process cleanup will be retried.";

const resultStatus = (result: ProcessResult): ExecutionCompletion["status"] =>
  result.cancelled
    ? "CANCELLED"
    : result.timedOut
      ? "TIMED_OUT"
      : result.exitCode === 0
        ? "SUCCEEDED"
        : "FAILED";

function warnPreservedBuild(completion: ExecutionCompletion): void {
  completion.result.warnings = [
    ...new Set([
      ...(completion.result.warnings ?? []),
      PROCESS_INSPECTION_WARNING,
    ]),
  ];
}

function resourceSignature(value: unknown): string {
  return JSON.stringify(
    parseOperationDescriptor(value).resources.map(
      ({ kind, key, mode, agentId, codebaseId, path }) => [
        kind,
        key,
        mode,
        agentId ?? null,
        codebaseId ?? null,
        path ?? null,
      ],
    ),
  );
}

export class JobExecutor {
  private readonly running = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  private stopping = false;
  private readonly cleanupPending = new Set<string>();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly client: AgentGraphQLClient,
    private readonly repositoryCoordinator = new RepositoryCoordinator(),
  ) {}

  execute(job: AgentJob): void {
    if (this.stopping || this.running.has(job.id)) return;
    const controller = new AbortController();
    const task = this.run(job, controller).finally(() => {
      this.running.delete(job.id);
      this.cleanupPending.delete(job.id);
    });
    this.running.set(job.id, { controller, task });
  }

  cancel(jobId: string): boolean {
    const running = this.running.get(jobId);
    if (!this.cleanupPending.has(jobId)) running?.controller.abort();
    return Boolean(running);
  }

  /** Hold source resources until interrupted subprocess cleanup is verified. */
  async recover(
    job: AgentJob,
    status: AgentJob["status"],
    waitForCompletion = false,
  ): Promise<void> {
    if (!job.executionToken) return;
    const existing = this.running.get(job.id);
    if (existing) {
      if (waitForCompletion) await existing.task;
      return;
    }
    const identity = {
      agentId: job.agentId,
      jobId: job.id,
      executionToken: job.executionToken,
    };
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const descriptor = job.operationResources
      ? parseOperationDescriptor(job.operationResources)
      : { version: 1 as const, resources: [] };
    const task = this.repositoryCoordinator
      .withResources(
        descriptor.resources,
        async () => {
          entered.resolve();
          let reported = false;
          let completion: ExecutionCompletion | undefined;
          let checkpointRead = false;
          let completedStatus = status;
          while (!this.shutdown.signal.aborted) {
            try {
              if (!checkpointRead) {
                completion =
                  job.kind === IOS_BUILD_JOB_KIND
                    ? executionCompletion(identity)
                    : undefined;
                checkpointRead = true;
                if (
                  completion &&
                  ["RUNNING", "CANCELLING"].includes(job.status)
                )
                  completedStatus = completion.status;
              }
              await recoverExecution(identity, this.shutdown.signal);
              await this.client.completeJob(
                job.id,
                completedStatus,
                completion?.result,
                completion?.error ??
                  (completion
                    ? undefined
                    : "Agent service restarted; interrupted processes were stopped and verified"),
                job.executionToken,
              );
              forgetExecution(identity);
              return;
            } catch (error) {
              if (
                completion &&
                error instanceof ProcessInspectionTimeoutError
              ) {
                warnPreservedBuild(completion);
                try {
                  await this.client.completeJob(
                    job.id,
                    completedStatus,
                    completion.result,
                    completion.error,
                    job.executionToken,
                    false,
                  );
                } catch (reportError) {
                  console.error(
                    `Could not preserve completed build ${job.id}:`,
                    reportError,
                  );
                }
              }
              if (!reported) {
                console.error(
                  `Cleanup verification required for job ${job.id}; execution resources remain protected:`,
                  error instanceof Error ? error.message : error,
                );
                reported = true;
              }
              await waitForAgentRetry(1_000, this.shutdown.signal);
            }
          }
        },
        this.shutdown.signal,
      )
      .catch((error: unknown) => {
        entered.resolve();
        if (!this.shutdown.signal.aborted)
          console.error(
            `Could not reserve recovery resources for ${job.id}:`,
            error,
          );
      })
      .finally(() => this.running.delete(job.id));
    this.running.set(job.id, { controller, task });
    await (waitForCompletion ? task : entered.promise);
  }

  async cancelAll(): Promise<void> {
    this.stopping = true;
    this.shutdown.abort();
    closeAllWorktreeWatches();
    const jobs = [...this.running.values()];
    for (const { controller } of jobs) controller.abort();
    await Promise.allSettled(jobs.map(({ task }) => task));
  }

  private async run(job: AgentJob, controller: AbortController): Promise<void> {
    if (!job.operationResources) return this.runGranted(job, controller, false);
    try {
      const descriptor = parseOperationDescriptor(job.operationResources);
      await this.repositoryCoordinator.withResources(
        descriptor.resources,
        () => this.runGranted(job, controller, true),
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted)
        console.error(`Could not schedule job ${job.id}:`, error);
    }
  }

  private async runGranted(
    job: AgentJob,
    controller: AbortController,
    resourceAware: boolean,
  ): Promise<void> {
    let claimed: AgentJob;
    try {
      claimed = resourceAware
        ? await this.client.claimJob(job.id, job.executionToken ?? randomUUID())
        : await this.client.claimJob(job.id);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "RESOURCE_BUSY" ||
          /RESOURCE_BUSY|resources? (?:are |is )?busy/i.test(error.message) ||
          ("codes" in error &&
            Array.isArray(error.codes) &&
            error.codes.includes("RESOURCE_BUSY")))
      )
        return;
      console.error(
        `Could not claim job ${job.id}; durable reconciliation will retry:`,
        error instanceof Error ? error.message : error,
      );
      return;
    }

    let status: AgentJob["status"];
    let result: ProcessResult | undefined;
    let completionError: string | undefined;
    try {
      if (resourceAware && !claimed.executionToken)
        throw new Error("The execution grant is missing its cleanup token");
      if (
        resourceAware &&
        resourceSignature(job.operationResources) !==
          resourceSignature(claimed.operationResources)
      )
        throw new Error(
          "Execution resources changed after scheduling; retry this operation",
        );
      const handler = handlers[claimed.kind];
      if (!handler)
        throw new Error(`No local handler is registered for ${claimed.kind}`);
      let execution:
        | {
            settle: () => Promise<void>;
            checkpointCompletion: (completion: ExecutionCompletion) => void;
          }
        | undefined;
      const runHandler = () => {
        controller.signal.throwIfAborted();
        return handler(
          claimed.payload,
          claimed.timeoutSeconds * 1_000,
          controller.signal,
          (log) => this.client.appendLog(claimed.id, log).then(() => undefined),
          {
            agentId: claimed.agentId,
            withOperationResources: (resources, task) =>
              this.repositoryCoordinator.withResources(
                resources.map((resource) => ({
                  ...resource,
                  agentId: resource.agentId ?? claimed.agentId,
                })),
                task,
                controller.signal,
              ),
            tryWithOperationResources: (resources, task) =>
              this.repositoryCoordinator.tryWithResources(
                resources.map((resource) => ({
                  ...resource,
                  agentId: resource.agentId ?? claimed.agentId,
                })),
                task,
                controller.signal,
              ),
            reportBranchDeletionResult: (result) =>
              this.client.reportBranchDeletionResult(claimed.id, result),
            reportWorktreeActivity: (input) =>
              this.client.reportWorktreeActivity(input),
            refreshFetchedCodebase: (input) =>
              refreshFetchedCodebase(
                this.client,
                input,
                claimed.timeoutSeconds * 1_000,
                controller.signal,
                (gitDirectory, task, folder) =>
                  this.repositoryCoordinator.withResources(
                    [
                      {
                        kind: "WORKTREE",
                        key: `${claimed.agentId}:worktree:${gitDirectory}`,
                        agentId: claimed.agentId,
                        codebaseId: input.codebaseId,
                        mode: "READ",
                      },
                      {
                        kind: "PATH",
                        key: folder,
                        path: folder,
                        agentId: claimed.agentId,
                        codebaseId: input.codebaseId,
                        mode: "READ",
                      },
                    ],
                    task,
                    controller.signal,
                  ),
              ),
            reportBuildProgress: (input) =>
              this.client.reportBuildProgress(input),
            ...(resourceAware && claimed.kind === IOS_BUILD_JOB_KIND
              ? {
                  finalizeBuildResult: async (
                    completedResult: ProcessResult,
                  ) => {
                    if (!execution)
                      throw new Error("Build execution journal is unavailable");
                    result = completedResult;
                    const completion: ExecutionCompletion = {
                      status: resultStatus(completedResult),
                      result: completedResult,
                      ...(completedResult.exitCode !== 0 &&
                      !completedResult.cancelled &&
                      !completedResult.timedOut
                        ? {
                            error: `Process exited with code ${completedResult.exitCode}`,
                          }
                        : {}),
                    };
                    execution.checkpointCompletion(completion);
                    this.cleanupPending.add(claimed.id);
                    try {
                      await execution.settle();
                      return;
                    } catch (error) {
                      if (!(error instanceof ProcessInspectionTimeoutError))
                        throw error;
                    }
                    warnPreservedBuild(completion);
                    execution.checkpointCompletion(completion);
                    let preserved = false;
                    while (!this.shutdown.signal.aborted) {
                      try {
                        if (!preserved) {
                          await this.client.completeJob(
                            claimed.id,
                            completion.status,
                            completion.result,
                            completion.error,
                            claimed.executionToken,
                            false,
                          );
                          preserved = true;
                        }
                        await execution.settle();
                        return;
                      } catch (error) {
                        console.error(
                          `Build ${claimed.id} result is preserved; cleanup verification will retry:`,
                          error instanceof Error ? error.message : error,
                        );
                        await waitForAgentRetry(1_000, this.shutdown.signal);
                      }
                    }
                    throw new Error(
                      "Build cleanup interrupted by agent shutdown; its result remains protected",
                    );
                  },
                }
              : {}),
            reportBuildDeploymentLaunched: (deploymentId, launchedAt) =>
              this.client.reportBuildDeploymentLaunched(
                claimed.id,
                deploymentId,
                launchedAt,
              ),
            appendBuildLogChunks: (buildId, chunks) =>
              this.client.appendBuildLogChunks(buildId, chunks),
            uploadBuildArtifact: (input) =>
              this.client.uploadBuildArtifact(input),
            uploadBuildArtifactTransfer: (input) =>
              this.client.uploadBuildArtifactTransfer(input),
            downloadBuildArtifactTransfer: (input) =>
              this.client.downloadBuildArtifactTransfer(input),
            downloadDsymDwarf: (input) => this.client.downloadDsymDwarf(input),
            claimSigningSecretTransfer: (transferId) =>
              this.client.claimSigningSecretTransfer(transferId),
            claimWorkflowJobSecrets: () =>
              this.client.claimWorkflowJobSecrets(claimed.id),
            appendCommandOutput: (attemptId, chunks) =>
              this.client.appendCommandOutput(claimed.id, attemptId, chunks),
          },
        );
      };
      const codebaseId =
        claimed.payload &&
        typeof claimed.payload === "object" &&
        !Array.isArray(claimed.payload) &&
        typeof (claimed.payload as Record<string, unknown>).codebaseId ===
          "string"
          ? String((claimed.payload as Record<string, unknown>).codebaseId)
          : null;
      if (resourceAware)
        result = await withExecutionJournal(
          {
            agentId: claimed.agentId,
            jobId: claimed.id,
            executionToken: claimed.executionToken!,
          },
          (journal) => {
            execution = journal;
            return runHandler();
          },
        );
      else if (!codebaseId) result = await runHandler();
      else if (claimed.kind === IOS_BUILD_JOB_KIND) {
        result = await this.repositoryCoordinator.runBuild(
          codebaseId,
          runHandler,
          controller.signal,
        );
      } else if (
        claimed.kind === WORKTREE_INSPECT_JOB_KIND ||
        claimed.kind === WORKTREE_DIFF_JOB_KIND ||
        claimed.kind === WORKTREE_DIFF_ASSET_JOB_KIND ||
        claimed.kind === WORKTREE_GIT_INSPECT_JOB_KIND ||
        claimed.kind === CODEBASE_GIT_INSPECT_JOB_KIND
      ) {
        // A background fetch can update live refs while these read them, just
        // as an external Git process can. User mutations remain exclusive.
        result = await this.repositoryCoordinator.runInspection(
          codebaseId,
          runHandler,
          controller.signal,
        );
      } else {
        result = await this.repositoryCoordinator.run(
          codebaseId,
          runHandler,
          controller.signal,
        );
      }
      status = result.cancelled
        ? "CANCELLED"
        : result.timedOut
          ? "TIMED_OUT"
          : result.exitCode === 0
            ? "SUCCEEDED"
            : "FAILED";
      completionError =
        status === "FAILED"
          ? `Process exited with code ${result.exitCode}`
          : undefined;
    } catch (error) {
      completionError = error instanceof Error ? error.message : String(error);
      status = controller.signal.aborted ? "CANCELLED" : "FAILED";
      console.error(`Job ${claimed.id} failed:`, completionError);
    }

    // Keep the result and the running entry until the server accepts completion.
    // Releasing this entry during an outage lets reconciliation rerun the handler.
    if (this.stopping && this.cleanupPending.has(claimed.id)) return;
    for (let attempt = 1; ; attempt++) {
      try {
        if (resourceAware && claimed.executionToken)
          await recoverExecution(
            {
              agentId: claimed.agentId,
              jobId: claimed.id,
              executionToken: claimed.executionToken!,
            },
            this.shutdown.signal,
          );
        if (resourceAware)
          await this.client.completeJob(
            claimed.id,
            status,
            result,
            completionError,
            claimed.executionToken,
          );
        else
          await this.client.completeJob(
            claimed.id,
            status,
            result,
            completionError,
          );
        if (resourceAware && claimed.executionToken)
          forgetExecution({
            agentId: claimed.agentId,
            jobId: claimed.id,
            executionToken: claimed.executionToken!,
          });
        return;
      } catch (error) {
        if (this.stopping) return;
        if (!isRetryableAgentError(error)) {
          console.error(
            `Could not report completion for ${claimed.id}; giving up after ${attempt} attempts:`,
            error instanceof Error ? error.message : error,
          );
          return;
        }
        console.error(
          `Could not report completion for ${claimed.id}; retrying:`,
          error instanceof Error ? error.message : error,
        );
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
        await waitForAgentRetry(delay, this.shutdown.signal);
        if (this.stopping) return;
      }
    }
  }
}
