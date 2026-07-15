import { AgentGraphQLClient, type AgentJob } from "./graphql-client.js";
import { handlers } from "./handlers/index.js";

export class JobExecutor {
  private readonly running = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();

  constructor(private readonly client: AgentGraphQLClient) {}

  execute(job: AgentJob): void {
    if (this.running.has(job.id)) return;
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
    const jobs = [...this.running.values()];
    for (const { controller } of jobs) controller.abort();
    await Promise.allSettled(jobs.map(({ task }) => task));
  }

  private async run(job: AgentJob, controller: AbortController): Promise<void> {
    try {
      const claimed = await this.client.claimJob(job.id);
      const handler = handlers[claimed.kind];
      if (!handler)
        throw new Error(`No local handler is registered for ${claimed.kind}`);
      const result = await handler(
        claimed.payload,
        claimed.timeoutSeconds * 1_000,
        controller.signal,
        (log) => this.client.appendLog(claimed.id, log).then(() => undefined),
      );
      const status = result.cancelled
        ? "CANCELLED"
        : result.timedOut
          ? "TIMED_OUT"
          : result.exitCode === 0
            ? "SUCCEEDED"
            : "FAILED";
      await this.client.completeJob(
        claimed.id,
        status,
        result,
        status === "FAILED"
          ? `Process exited with code ${result.exitCode}`
          : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Job ${job.id} failed:`, message);
      try {
        await this.client.completeJob(
          job.id,
          controller.signal.aborted ? "CANCELLED" : "FAILED",
          undefined,
          message,
        );
      } catch (completionError) {
        console.error(
          `Could not report completion for ${job.id}:`,
          completionError,
        );
      }
    }
  }
}
