import { AgentGraphQLClient, type AgentJob } from "./graphql-client.js";
import { handlers } from "./handlers/index.js";
import type { ProcessResult } from "./process-runner.js";
import { RepositoryCoordinator } from "./repository-coordinator.js";

export class JobExecutor {
  private readonly running = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  private stopping = false;

  constructor(
    private readonly client: AgentGraphQLClient,
    private readonly repositoryCoordinator = new RepositoryCoordinator(),
  ) {}

  execute(job: AgentJob): void {
    if (this.stopping || this.running.has(job.id)) return;
    const controller = new AbortController();
    const task = this.run(job, controller).finally(() =>
      this.running.delete(job.id),
    );
    this.running.set(job.id, { controller, task });
  }

  cancel(jobId: string): void {
    this.running.get(jobId)?.controller.abort();
  }

  async cancelAll(): Promise<void> {
    this.stopping = true;
    const jobs = [...this.running.values()];
    for (const { controller } of jobs) controller.abort();
    await Promise.allSettled(jobs.map(({ task }) => task));
  }

  private async run(job: AgentJob, controller: AbortController): Promise<void> {
    let claimed: AgentJob;
    try {
      claimed = await this.client.claimJob(job.id);
    } catch (error) {
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
      const handler = handlers[claimed.kind];
      if (!handler)
        throw new Error(`No local handler is registered for ${claimed.kind}`);
      const runHandler = () =>
        handler(
          claimed.payload,
          claimed.timeoutSeconds * 1_000,
          controller.signal,
          (log) => this.client.appendLog(claimed.id, log).then(() => undefined),
        );
      const codebaseId =
        claimed.payload &&
        typeof claimed.payload === "object" &&
        !Array.isArray(claimed.payload) &&
        typeof (claimed.payload as Record<string, unknown>).codebaseId ===
          "string"
          ? String((claimed.payload as Record<string, unknown>).codebaseId)
          : null;
      result = codebaseId
        ? await this.repositoryCoordinator.run(codebaseId, runHandler)
        : await runHandler();
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

    let retry = 0;
    while (true) {
      try {
        await this.client.completeJob(
          claimed.id,
          status,
          result,
          completionError,
        );
        return;
      } catch (error) {
        console.error(
          `Could not report completion for ${claimed.id}; retrying:`,
          error instanceof Error ? error.message : error,
        );
        if (this.stopping) return;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retry++, 5));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
