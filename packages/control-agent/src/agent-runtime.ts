import type { AgentConfig } from "./config.js";
import {
  AgentGraphQLClient,
  createAgentSubscriptionClient,
  subscribeToAgentEvents,
} from "./graphql-client.js";
import { collectInventory } from "./inventory.js";
import { JobExecutor } from "./job-executor.js";
import { CodebaseMonitor } from "./codebase-monitor.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

export async function runAgent(
  config: AgentConfig,
  signal: AbortSignal,
): Promise<void> {
  const client = new AgentGraphQLClient(config.server, config.credential);
  const executor = new JobExecutor(client);
  const codebaseMonitor = new CodebaseMonitor(client);
  const inventory = collectInventory();
  let reconciling = false;
  let codebaseTimer: ReturnType<typeof setTimeout> | undefined;
  let startupRecoveryPending = true;
  const interruptedJobs = new Set<string>();

  const reconcileJobs = async (recoverInterrupted: boolean) => {
    let jobs;
    try {
      jobs = await client.pendingJobs(config.agentId);
    } catch (error) {
      console.error(
        "Durable job reconciliation failed:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
    await Promise.all(
      jobs.map(async (job) => {
        if (job.status === "CANCELLED") {
          executor.cancel(job.id);
          return;
        }
        if (
          job.status !== "RUNNING" ||
          (!recoverInterrupted && !interruptedJobs.has(job.id))
        ) {
          executor.execute(job);
          return;
        }
        interruptedJobs.add(job.id);
        try {
          await client.completeJob(
            job.id,
            "FAILED",
            undefined,
            "Agent service restarted while this job was running",
          );
          interruptedJobs.delete(job.id);
        } catch (error) {
          console.error(
            `Could not reconcile interrupted job ${job.id}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }),
    );
    return true;
  };

  const heartbeat = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      try {
        await client.heartbeat(inventory);
      } catch (error) {
        console.error(
          "Heartbeat failed:",
          error instanceof Error ? error.message : error,
        );
      }
      if (await reconcileJobs(startupRecoveryPending)) {
        startupRecoveryPending = false;
      }
    } finally {
      reconciling = false;
    }
  };

  const reconcileCodebases = async () => {
    await codebaseMonitor.reconcile(signal);
    if (!signal.aborted) {
      codebaseTimer = setTimeout(
        () => void reconcileCodebases(),
        codebaseMonitor.reconcileIntervalMs,
      );
    }
  };

  await heartbeat();
  void reconcileCodebases();

  const subscriptionClient = createAgentSubscriptionClient(config);
  const unsubscribe = subscribeToAgentEvents(
    subscriptionClient,
    config.agentId,
    (event) => {
      if (event.type === "JOB_AVAILABLE") executor.execute(event.job);
      else executor.cancel(event.job.id);
    },
  );
  const heartbeatTimer = setInterval(
    () => void heartbeat(),
    HEARTBEAT_INTERVAL_MS,
  );

  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

  clearInterval(heartbeatTimer);
  if (codebaseTimer) clearTimeout(codebaseTimer);
  unsubscribe();
  await subscriptionClient.dispose();
  await executor.cancelAll();
}
