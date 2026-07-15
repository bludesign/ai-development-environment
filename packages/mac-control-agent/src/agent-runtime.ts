import type { AgentConfig } from "./config.js";
import {
  AgentGraphQLClient,
  createAgentSubscriptionClient,
  subscribeToAgentEvents,
} from "./graphql-client.js";
import { collectInventory } from "./inventory.js";
import { JobExecutor } from "./job-executor.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

export async function runAgent(
  config: AgentConfig,
  signal: AbortSignal,
): Promise<void> {
  const client = new AgentGraphQLClient(config.server, config.credential);
  const executor = new JobExecutor(client);
  const inventory = collectInventory();
  let reconciling = false;
  let acceptDurableJobs = false;

  const heartbeat = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      await client.heartbeat(inventory);
      if (acceptDurableJobs) {
        const durableJobs = await client.pendingJobs(config.agentId);
        for (const job of durableJobs) {
          if (job.status === "QUEUED") executor.execute(job);
        }
      }
    } catch (error) {
      console.error(
        "Heartbeat failed:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      reconciling = false;
    }
  };

  await heartbeat();
  const jobs = await client.pendingJobs(config.agentId);
  for (const job of jobs) {
    if (job.status === "RUNNING") {
      await client.completeJob(
        job.id,
        "FAILED",
        undefined,
        "Agent service restarted while this job was running",
      );
    } else {
      executor.execute(job);
    }
  }
  acceptDurableJobs = true;

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
  unsubscribe();
  await subscriptionClient.dispose();
  await executor.cancelAll();
}
